const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export const MAX_DURATION_SECONDS = 2 * 60 * 60;

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
    id: info.id,
    title: info.title || 'Untitled video',
    creator: info.channel || info.uploader || 'YouTube',
    duration: Number(info.duration) || 0,
    thumbnail: selectThumbnail(info),
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
