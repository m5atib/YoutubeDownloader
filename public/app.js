const form = document.querySelector('#converter-form');
const input = document.querySelector('#video-url');
const inputRow = document.querySelector('#input-row');
const clearButton = document.querySelector('#clear-button');
const downloadButton = document.querySelector('#download-button');
const buttonText = document.querySelector('#button-text');
const message = document.querySelector('#form-message');
const preview = document.querySelector('#preview');
const previewImage = document.querySelector('#preview-image');
const previewTitle = document.querySelector('#preview-title');
const previewCreator = document.querySelector('#preview-creator');
const previewDuration = document.querySelector('#preview-duration');

let previewTimer;
let previewController;
let previewedUrl = '';

input.addEventListener('input', () => {
  clearButton.classList.toggle('visible', Boolean(input.value));
  inputRow.classList.remove('invalid');
  setMessage('');
  hidePreview();
  window.clearTimeout(previewTimer);
  previewController?.abort();

  if (looksLikeYouTubeUrl(input.value)) {
    previewTimer = window.setTimeout(() => loadPreview(input.value.trim()), 500);
  }
});

clearButton.addEventListener('click', () => {
  input.value = '';
  clearButton.classList.remove('visible');
  hidePreview();
  setMessage('');
  input.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();

  if (!looksLikeYouTubeUrl(url)) {
    showError('Paste a complete YouTube link to continue.');
    return;
  }

  setLoading(true);
  setMessage('Finding the best audio and creating your MP3…');

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) throw new Error(await getErrorMessage(response));

    const blob = await response.blob();
    const filename = getFilename(response.headers.get('content-disposition')) || 'youtube-audio.mp3';
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
    setMessage('Your MP3 is ready. The download has started.', 'success');
  } catch (error) {
    showError(error.message || 'The download could not be completed.');
  } finally {
    setLoading(false);
  }
});

async function loadPreview(url) {
  previewController = new AbortController();
  setMessage('Checking the link…');

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: previewController.signal,
    });

    if (!response.ok) throw new Error(await getErrorMessage(response));
    const info = await response.json();
    if (input.value.trim() !== url) return;

    previewedUrl = url;
    previewImage.src = info.thumbnail;
    previewImage.alt = `Thumbnail for ${info.title}`;
    previewTitle.textContent = info.title;
    previewCreator.textContent = info.creator;
    previewDuration.textContent = formatDuration(info.duration);
    preview.hidden = false;
    setMessage('');
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (input.value.trim() === url) showError(error.message);
  }
}

function looksLikeYouTubeUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && [
      'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
    ].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function hidePreview() {
  preview.hidden = true;
  previewedUrl = '';
  previewImage.removeAttribute('src');
}

function setLoading(loading) {
  downloadButton.disabled = loading;
  downloadButton.classList.toggle('loading', loading);
  buttonText.textContent = loading ? 'Preparing your MP3' : 'Download MP3';
}

function showError(text) {
  inputRow.classList.add('invalid');
  setMessage(text, 'error');
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

async function getErrorMessage(response) {
  try {
    const payload = await response.json();
    return payload.error || 'The video could not be processed.';
  } catch {
    return 'The video could not be processed.';
  }
}

function getFilename(header) {
  if (!header) return '';
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || '';
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = Math.floor(total % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}
