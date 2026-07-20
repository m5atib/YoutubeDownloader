const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export const MAX_DURATION_SECONDS = 2 * 60 * 60;
export const MAX_PLAYLIST_ITEMS = 200;

export function parseYouTubeUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new Error('Enter a valid YouTube link.');
  }

  const candidate = value.trim();
  if (!candidate) throw new Error('Paste a YouTube link first.');

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Enter a complete YouTube link.');
  }

  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Only HTTPS links from YouTube are supported.');
  }

  if (url.hostname.toLowerCase() === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (!id) throw new Error('This YouTube link is missing a video ID.');
  }

  return url.toString();
}

export function safeDownloadName(title) {
  const clean = String(title || 'youtube-audio')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 120);

  return `${clean || 'youtube-audio'}.mp3`;
}

export function publicVideoInfo(info) {
  return {
    kind: 'video',
    id: info.id,
    title: info.title || 'Untitled video',
    creator: info.channel || info.uploader || 'YouTube',
    duration: Number(info.duration) || 0,
    thumbnail: selectThumbnail(info),
  };
}

export function publicPlaylistInfo(info) {
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
  const firstEntry = entries[0] || {};

  return {
    kind: 'playlist',
    id: info.id,
    title: info.title || 'YouTube playlist',
    creator: info.channel || info.uploader || firstEntry.channel || 'YouTube',
    duration: entries.reduce((total, entry) => total + (Number(entry.duration) || 0), 0),
    itemCount: entries.length,
    thumbnail: selectThumbnail(info) || selectThumbnail(firstEntry),
  };
}

function selectThumbnail(info) {
  if (typeof info.thumbnail === 'string') return info.thumbnail;
  if (!Array.isArray(info.thumbnails)) return '';

  return info.thumbnails
    .filter((item) => item?.url)
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
}

export function assertDurationAllowed(duration) {
  const seconds = Number(duration) || 0;
  if (seconds > MAX_DURATION_SECONDS) {
    throw new Error('Videos longer than 2 hours are not supported.');
  }
}

export function assertPlaylistAllowed(itemCount) {
  const count = Number(itemCount) || 0;
  if (!count) throw new Error('This playlist does not contain any available videos.');
  if (count > MAX_PLAYLIST_ITEMS) {
    throw new Error(`Playlists are limited to ${MAX_PLAYLIST_ITEMS} videos.`);
  }
}

export function isPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname === '/playlist' || url.searchParams.has('list');
  } catch {
    return false;
  }
}

export function extractDownloadPercentage(output) {
  const matches = [...String(output).matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)];
  if (!matches.length) return null;

  return Math.min(100, Math.max(0, Number(matches.at(-1)[1])));
}
