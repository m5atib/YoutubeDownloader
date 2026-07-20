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
  assertPlaylistAllowed,
  extractDownloadPercentage,
  isPlaylistUrl,
  parseYouTubeUrl,
  publicPlaylistInfo,
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
    if (isPlaylistUrl(url)) {
      const info = await getPlaylistInfo(url);
      assertPlaylistAllowed(info.entries?.length);
      return response.json(publicPlaylistInfo(info));
    }

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
      kind: isPlaylistUrl(url) ? 'playlist' : 'video',
      status: 'processing',
      progress: 2,
      stage: 'Checking link…',
      title: '',
      tempDirectory: '',
      audioPath: '',
      filename: '',
      error: '',
      itemCount: 1,
      completedItems: 0,
      skippedItems: 0,
      currentItem: null,
      deliveryTimer: null,
      deliveryResolve: null,
      deliveryReject: null,
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
  if (!['ready', 'item-ready'].includes(job.status) || !existsSync(job.audioPath)) {
    return response.status(409).json({ error: 'The MP3 is not ready yet.' });
  }

  clearTimeout(job.cleanupTimer);
  response.download(job.audioPath, job.filename, async (error) => {
    if (job.kind === 'playlist') {
      await rm(job.audioPath, { force: true }).catch(() => {});
      job.audioPath = '';
      clearTimeout(job.deliveryTimer);
      if (error) job.deliveryReject?.(error);
      else job.deliveryResolve?.();
      job.deliveryResolve = null;
      job.deliveryReject = null;
    } else {
      await cleanupJob(job.id);
    }
    if (error && !response.headersSent) sendMediaError(response, error);
  });
});

async function processDownloadJob(job) {
  try {
    job.tempDirectory = await mkdtemp(join(tmpdir(), 'videlody-'));
    if (job.kind === 'playlist') await processPlaylistJob(job);
    else await processVideoJob(job);
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

async function processVideoJob(job) {
  const info = await getVideoInfo(job.url);
  assertDurationAllowed(info.duration);
  job.title = info.title || 'YouTube audio';
  job.progress = 8;
  job.stage = 'Preparing audio source…';
  job.audioPath = join(job.tempDirectory, 'audio.mp3');
  job.filename = safeDownloadName(info.title);

  await downloadAudio(job, job.url, join(job.tempDirectory, 'audio.%(ext)s'), {
    baseProgress: 10,
    progressSpan: 72,
    downloadStage: 'Downloading source audio…',
    conversionProgress: 86,
    conversionStage: 'Converting audio to MP3…',
  });

  if (!existsSync(job.audioPath)) {
    throw new Error('The MP3 could not be created. Please try another video.');
  }

  job.status = 'ready';
  job.progress = 92;
  job.stage = 'MP3 ready—starting download…';
}

async function processPlaylistJob(job) {
  const info = await getPlaylistInfo(job.url);
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
  assertPlaylistAllowed(entries.length);
  job.title = info.title || 'YouTube playlist';
  job.itemCount = entries.length;
  job.progress = 6;
  job.stage = `Playlist found—${entries.length} tracks`;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const itemNumber = index + 1;
    const itemTitle = entry.title || `Track ${itemNumber}`;
    const itemUrl = playlistEntryUrl(entry);
    const baseProgress = 8 + (index / entries.length) * 90;
    const progressSpan = 90 / entries.length;
    const fileBase = `playlist-${String(itemNumber).padStart(3, '0')}`;
    job.currentItem = { index: itemNumber, title: itemTitle };
    job.status = 'processing';
    job.progress = baseProgress;
    job.stage = `Track ${itemNumber}/${entries.length}: preparing…`;

    try {
      if (Number(entry.duration) > 0) assertDurationAllowed(entry.duration);
      job.audioPath = join(job.tempDirectory, `${fileBase}.mp3`);
      job.filename = safeDownloadName(`${String(itemNumber).padStart(3, '0')} - ${itemTitle}`);

      await downloadAudio(job, itemUrl, join(job.tempDirectory, `${fileBase}.%(ext)s`), {
        baseProgress,
        progressSpan: progressSpan * 0.82,
        downloadStage: `Track ${itemNumber}/${entries.length}: downloading…`,
        conversionProgress: baseProgress + progressSpan * 0.88,
        conversionStage: `Track ${itemNumber}/${entries.length}: converting to MP3…`,
      });

      if (!existsSync(job.audioPath)) throw new Error('Track MP3 was not created.');
      job.status = 'item-ready';
      job.progress = baseProgress + progressSpan * 0.94;
      job.stage = `Track ${itemNumber}/${entries.length}: saving to your device…`;
      await waitForItemDelivery(job);
      job.completedItems += 1;
      job.progress = baseProgress + progressSpan;
    } catch (error) {
      if (/Timed out waiting for the playlist download/i.test(error instanceof Error ? error.message : '')) {
        throw error;
      }
      console.error(`Skipping playlist item ${itemNumber}:`, error);
      job.skippedItems += 1;
      await rm(job.audioPath, { force: true }).catch(() => {});
      job.audioPath = '';
    }
  }

  if (!job.completedItems) throw new Error('No playlist tracks could be downloaded.');
  job.currentItem = null;
  job.status = 'complete';
  job.progress = 100;
  job.stage = job.skippedItems
    ? `Playlist complete—${job.completedItems} saved, ${job.skippedItems} skipped`
    : `Playlist complete—${job.completedItems} tracks saved`;
}

async function downloadAudio(job, url, outputTemplate, progressContext) {
  const subprocess = youtubeDl.exec(url, {
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

  const updateFromOutput = (chunk) => updateJobProgress(job, String(chunk), progressContext);
  subprocess.stdout?.on('data', updateFromOutput);
  subprocess.stderr?.on('data', updateFromOutput);
  await subprocess;
}

function updateJobProgress(job, output, context) {
  const sourceProgress = extractDownloadPercentage(output);
  if (sourceProgress !== null) {
    job.progress = Math.max(
      job.progress,
      context.baseProgress + (sourceProgress / 100) * context.progressSpan,
    );
    job.stage = context.downloadStage;
  }

  if (/\[(?:ExtractAudio|ffmpeg)\]|Destination: .*\.mp3/i.test(output)) {
    job.progress = Math.max(job.progress, context.conversionProgress);
    job.stage = context.conversionStage;
  }
}

function waitForItemDelivery(job) {
  return new Promise((resolve, reject) => {
    job.deliveryResolve = () => {
      clearTimeout(job.deliveryTimer);
      resolve();
    };
    job.deliveryReject = (error) => {
      clearTimeout(job.deliveryTimer);
      reject(error);
    };
    job.deliveryTimer = setTimeout(
      () => job.deliveryReject?.(new Error('Timed out waiting for the playlist download.')),
      READY_JOB_TTL_MS,
    );
    job.deliveryTimer.unref?.();
  });
}

function playlistEntryUrl(entry) {
  if (typeof entry.webpage_url === 'string') return entry.webpage_url;
  if (typeof entry.url === 'string' && entry.url.startsWith('http')) return entry.url;
  const id = entry.id || entry.url;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress),
    stage: job.stage,
    title: job.title,
    error: job.error,
    kind: job.kind,
    itemCount: job.itemCount,
    completedItems: job.completedItems,
    skippedItems: job.skippedItems,
    currentItem: job.currentItem,
  };
}

function scheduleJobCleanup(job, delay) {
  clearTimeout(job.cleanupTimer);
  clearTimeout(job.deliveryTimer);
  job.deliveryReject?.(new Error('Download job expired.'));
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

async function getPlaylistInfo(url) {
  return youtubeDl(url, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
  });
}

function sendMediaError(response, error) {
  if (response.headersSent) return;

  const knownMessage = error instanceof Error ? error.message : '';
  const isInputError = /YouTube link|YouTube are supported|video ID|Paste|complete|2 hours|playlist|Playlists/.test(knownMessage);
  const status = isInputError ? 400 : 422;

  if (!isInputError) console.error(error);
  response.status(status).json({
    error: isInputError
      ? knownMessage
      : 'We could not process that link. It may be private, restricted, or unavailable.',
  });
}

function mediaErrorMessage(error) {
  const knownMessage = error instanceof Error ? error.message : '';
  const isInputError = /YouTube link|YouTube are supported|video ID|Paste|complete|2 hours|playlist|Playlists/.test(knownMessage);
  return isInputError
    ? knownMessage
    : 'We could not process that link. It may be private, restricted, or unavailable.';
}

app.listen(port, () => {
  console.log(`Videlody is ready at http://localhost:${port}`);
});
