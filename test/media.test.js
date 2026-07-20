import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDurationAllowed,
  extractDownloadPercentage,
  parseYouTubeUrl,
  publicVideoInfo,
  safeDownloadName,
} from '../lib/media.js';

test('parseYouTubeUrl accepts supported YouTube hosts', () => {
  assert.equal(parseYouTubeUrl(' https://youtu.be/abc123 '), 'https://youtu.be/abc123');
  assert.equal(
    parseYouTubeUrl('https://www.youtube.com/watch?v=abc123'),
    'https://www.youtube.com/watch?v=abc123',
  );
});

test('parseYouTubeUrl rejects unsafe or unrelated URLs', () => {
  assert.throws(() => parseYouTubeUrl('http://youtube.com/watch?v=x'), /Only HTTPS/);
  assert.throws(() => parseYouTubeUrl('https://example.com/watch?v=x'), /Only HTTPS/);
  assert.throws(() => parseYouTubeUrl('not a url'), /complete YouTube link/);
});

test('safeDownloadName removes filesystem-unsafe characters', () => {
  assert.equal(safeDownloadName('  A / B: “Live”  '), 'A B “Live”.mp3');
  assert.equal(safeDownloadName('...'), 'youtube-audio.mp3');
});

test('duration guard rejects videos over two hours', () => {
  assert.doesNotThrow(() => assertDurationAllowed(7200));
  assert.throws(() => assertDurationAllowed(7201), /longer than 2 hours/);
});

test('publicVideoInfo exposes only the UI fields', () => {
  assert.deepEqual(
    publicVideoInfo({
      id: 'x',
      title: 'Song',
      channel: 'Artist',
      duration: 123,
      thumbnail: 'https://img.example/thumb.jpg',
      secret: 'not-public',
    }),
    {
      id: 'x',
      title: 'Song',
      creator: 'Artist',
      duration: 123,
      thumbnail: 'https://img.example/thumb.jpg',
    },
  );
});

test('extractDownloadPercentage reads the latest yt-dlp progress value', () => {
  assert.equal(extractDownloadPercentage('[download]  12.4% of 3.00MiB'), 12.4);
  assert.equal(
    extractDownloadPercentage('[download]  40.0%\n[download]  78.6% of 8.00MiB'),
    78.6,
  );
  assert.equal(extractDownloadPercentage('preparing audio'), null);
});
