import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import youtubeDl from 'youtube-dl-exec';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDurationAllowed,
  parseYouTubeUrl,
  publicVideoInfo,
  safeDownloadName,
} from './lib/media.js';

const app = express();
const port = Number(process.env.PORT) || 8787;
const publicDirectory = fileURLToPath(new URL('./public', import.meta.url));
const MAX_CONCURRENT_DOWNLOADS = 2;
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

app.post('/api/download', async (request, response) => {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return response.status(429).json({
      error: 'The converter is busy. Please try again in a moment.',
    });
  }

  let tempDirectory;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    const url = parseYouTubeUrl(request.body?.url);
    activeDownloads += 1;

    const info = await getVideoInfo(url);
    assertDurationAllowed(info.duration);

    tempDirectory = await mkdtemp(join(tmpdir(), 'videlody-'));
    const outputTemplate = join(tempDirectory, 'audio.%(ext)s');
    const mp3Path = join(tempDirectory, 'audio.mp3');

    await youtubeDl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '0',
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      noWarnings: true,
      output: outputTemplate,
    });

    if (!existsSync(mp3Path)) {
      throw new Error('The MP3 could not be created. Please try another video.');
    }

    response.download(mp3Path, safeDownloadName(info.title), async (error) => {
      await release();
      if (error && !response.headersSent) sendMediaError(response, error);
    });
  } catch (error) {
    await release();
    sendMediaError(response, error);
  }
});

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

app.listen(port, () => {
  console.log(`Videlody is ready at http://localhost:${port}`);
});
