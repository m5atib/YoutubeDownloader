import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import youtubeDl from 'youtube-dl-exec';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDurationAllowed,
  extractDownloadPercentage,
  parseYouTubeUrl,
  publicVideoInfo,
  safeDownloadName,
} from './lib/media.js';

const app = express();
const port = Number(process.env.PORT) || 8787;
const publicDirectory = fileURLToPath(new URL('./public', import.meta.url));
const MAX_CONCURRENT_DOWNLOADS = 2;
const READY_JOB_TTL_MS = 15 * 60 * 1_000;
const FAILED_JOB_TTL_MS = 5 * 60 * 1_000;
const jobs = new Map();
let activeDownloads = 0;

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(publicDirectory, { extensions: ['html'] }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

app.post('/api/info', async (request, response) => {
  try {
    const url = parseYouTubeUrl(request.body?.url);
    const info = await getVideoInfo(url);
    assertDurationAllowed(info.duration);
    response.json(publicVideoInfo(info));
  } catch (error) {
    sendMediaError(response, error);
  }
});

app.post('/api/jobs', (request, response) => {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return response.status(429).json({
      error: 'The converter is busy. Please try again in a moment.',
    });
  }

  try {
    const url = parseYouTubeUrl(request.body?.url);
    const job = {
      id: randomUUID(),
      url,
      status: 'processing',
      progress: 2,
      stage: 'Checking video…',
      title: '',
      tempDirectory: '',
      audioPath: '',
      filename: '',
      error: '',
      cleanupTimer: null,
    };

    jobs.set(job.id, job);
    activeDownloads += 1;
    void processDownloadJob(job);
    response.status(202).json(publicJob(job));
  } catch (error) {
    sendMediaError(response, error);
  }
});

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'This download job has expired.' });

  response.set('Cache-Control', 'no-store');
  response.json(publicJob(job));
});

app.get('/api/jobs/:id/file', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'This download job has expired.' });
  if (job.status !== 'ready' || !existsSync(job.audioPath)) {
    return response.status(409).json({ error: 'The MP3 is not ready yet.' });
  }

  clearTimeout(job.cleanupTimer);
  response.download(job.audioPath, job.filename, async (error) => {
    await cleanupJob(job.id);
    if (error && !response.headersSent) sendMediaError(response, error);
  });
});

async function processDownloadJob(job) {
  try {
    const info = await getVideoInfo(job.url);
    assertDurationAllowed(info.duration);
    job.title = info.title || 'YouTube audio';
    job.progress = 8;
    job.stage = 'Preparing audio source…';

    job.tempDirectory = await mkdtemp(join(tmpdir(), 'videlody-'));
    const outputTemplate = join(job.tempDirectory, 'audio.%(ext)s');
    job.audioPath = join(job.tempDirectory, 'audio.mp3');
    job.filename = safeDownloadName(info.title);

    const subprocess = youtubeDl.exec(job.url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '0',
      ffmpegLocation: ffmpegPath,
      jsRuntimes: 'node',
      newline: true,
      noPlaylist: true,
      noWarnings: true,
      output: outputTemplate,
      progress: true,
    });

    const updateFromOutput = (chunk) => updateJobProgress(job, String(chunk));
    subprocess.stdout?.on('data', updateFromOutput);
    subprocess.stderr?.on('data', updateFromOutput);
    await subprocess;

    if (!existsSync(job.audioPath)) {
      throw new Error('The MP3 could not be created. Please try another video.');
    }

    job.status = 'ready';
    job.progress = 92;
    job.stage = 'MP3 ready—starting download…';
    scheduleJobCleanup(job, READY_JOB_TTL_MS);
  } catch (error) {
    console.error(error);
    job.status = 'failed';
    job.stage = 'Conversion failed';
    job.error = mediaErrorMessage(error);
    if (job.tempDirectory) {
      await rm(job.tempDirectory, { recursive: true, force: true }).catch(() => {});
      job.tempDirectory = '';
    }
    scheduleJobCleanup(job, FAILED_JOB_TTL_MS);
  } finally {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}

function updateJobProgress(job, output) {
  const sourceProgress = extractDownloadPercentage(output);
  if (sourceProgress !== null) {
    job.progress = Math.max(job.progress, 10 + sourceProgress * 0.72);
    job.stage = 'Downloading source audio…';
  }

  if (/\[(?:ExtractAudio|ffmpeg)\]|Destination: .*\.mp3/i.test(output)) {
    job.progress = Math.max(job.progress, 86);
    job.stage = 'Converting audio to MP3…';
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress),
    stage: job.stage,
    title: job.title,
    error: job.error,
  };
}

function scheduleJobCleanup(job, delay) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => void cleanupJob(job.id), delay);
  job.cleanupTimer.unref?.();
}

async function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  clearTimeout(job.cleanupTimer);
  if (job.tempDirectory) {
    await rm(job.tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError) {
    return response.status(400).json({ error: 'The request could not be read.' });
  }
  console.error(error);
  response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function getVideoInfo(url) {
  return youtubeDl(url, {
    dumpSingleJson: true,
    noPlaylist: true,
    noWarnings: true,
    skipDownload: true,
  });
}

function sendMediaError(response, error) {
  if (response.headersSent) return;

  const knownMessage = error instanceof Error ? error.message : '';
  const isInputError = /YouTube link|YouTube are supported|video ID|Paste|complete|2 hours/.test(knownMessage);
  const status = isInputError ? 400 : 422;

  if (!isInputError) console.error(error);
  response.status(status).json({
    error: isInputError
      ? knownMessage
      : 'We could not process that video. It may be private, restricted, or unavailable.',
  });
}

function mediaErrorMessage(error) {
  const knownMessage = error instanceof Error ? error.message : '';
  const isInputError = /YouTube link|YouTube are supported|video ID|Paste|complete|2 hours/.test(knownMessage);
  return isInputError
    ? knownMessage
    : 'We could not process that video. It may be private, restricted, or unavailable.';
}

app.listen(port, () => {
  console.log(`Videlody is ready at http://localhost:${port}`);
});
