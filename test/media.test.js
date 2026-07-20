import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDurationAllowed,
  assertPlaylistAllowed,
  extractDownloadPercentage,
  isPlaylistUrl,
  parseYouTubeUrl,
  publicPlaylistInfo,
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
      kind: 'video',
      id: 'x',
      title: 'Song',
      creator: 'Artist',
      duration: 123,
      thumbnail: 'https://img.example/thumb.jpg',
    },
  );
});

test('playlist helpers identify, summarize, and bound playlists', () => {
  assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PL123'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=PL123'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=abc'), false);
  assert.doesNotThrow(() => assertPlaylistAllowed(113));
  assert.throws(() => assertPlaylistAllowed(0), /does not contain/);
  assert.throws(() => assertPlaylistAllowed(201), /limited to 200/);

  assert.deepEqual(
    publicPlaylistInfo({
      id: 'PL123',
      title: 'Favorites',
      channel: 'Listener',
      entries: [
        { duration: 60, thumbnail: 'https://img.example/one.jpg' },
        { duration: 90 },
      ],
    }),
    {
      kind: 'playlist',
      id: 'PL123',
      title: 'Favorites',
      creator: 'Listener',
      duration: 150,
      itemCount: 2,
      thumbnail: 'https://img.example/one.jpg',
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
