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
const progressPanel = document.querySelector('#download-progress');
const progressStage = document.querySelector('#progress-stage');
const progressValue = document.querySelector('#progress-value');
const progressFill = document.querySelector('#progress-fill');
const progressSteps = [...document.querySelectorAll('[data-progress-step]')];

let previewTimer;
let previewController;
let previewedUrl = '';
let progressResetTimer;

input.addEventListener('input', () => {
  clearButton.classList.toggle('visible', Boolean(input.value));
  inputRow.classList.remove('invalid');
  setMessage('');
  resetProgress();
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
  resetProgress();
  input.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();

  if (!looksLikeYouTubeUrl(url)) {
    showError('Paste a complete YouTube link to continue.');
    return;
  }

  previewController?.abort();
  setLoading(true);
  updateProgress(2, 'Checking video…');
  setMessage('Your download progress will appear below.');

  try {
    const createResponse = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!createResponse.ok) throw new Error(await getErrorMessage(createResponse));
    let job = await createResponse.json();
    job = await waitForJob(job);

    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/file`);
    if (!response.ok) throw new Error(await getErrorMessage(response));

    const blob = await readDownloadWithProgress(response);
    const filename = getFilename(response.headers.get('content-disposition')) || 'youtube-audio.mp3';
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
    updateProgress(100, 'Download complete');
    setMessage('Your MP3 is ready. The download has started.', 'success');
    progressResetTimer = window.setTimeout(resetProgress, 6_000);
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

async function waitForJob(initialJob) {
  let job = initialJob;

  while (job.status === 'processing') {
    updateProgress(job.progress, job.stage);
    await delay(650);

    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(await getErrorMessage(response));
    job = await response.json();
  }

  updateProgress(job.progress, job.stage);
  if (job.status === 'failed') {
    throw new Error(job.error || 'The video could not be processed.');
  }
  if (job.status !== 'ready') throw new Error('The download stopped unexpectedly.');
  return job;
}

async function readDownloadWithProgress(response) {
  const totalBytes = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !totalBytes) {
    const blob = await response.blob();
    updateProgress(100, 'Download complete');
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    const transferProgress = Math.min(1, receivedBytes / totalBytes);
    updateProgress(92 + transferProgress * 8, 'Downloading MP3 to your device…');
  }

  return new Blob(chunks, { type: response.headers.get('content-type') || 'audio/mpeg' });
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
  input.disabled = loading;
  clearButton.disabled = loading;
  downloadButton.classList.toggle('loading', loading);
  if (!loading) buttonText.textContent = 'Download MP3';
}

function showError(text) {
  inputRow.classList.add('invalid');
  resetProgress();
  setMessage(text, 'error');
}

function updateProgress(value, stage) {
  window.clearTimeout(progressResetTimer);
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  progressPanel.hidden = false;
  progressPanel.setAttribute('aria-valuenow', String(percent));
  progressFill.style.width = `${percent}%`;
  progressValue.textContent = `${percent}%`;
  progressStage.textContent = stage || 'Preparing your MP3…';
  buttonText.textContent = percent < 100 ? `Preparing MP3 · ${percent}%` : 'MP3 ready';

  const activeStep = percent < 10 ? 0 : percent < 92 ? 1 : 2;
  progressSteps.forEach((step, index) => {
    step.classList.toggle('active', index === activeStep);
    step.classList.toggle('complete', index < activeStep || percent === 100);
  });
}

function resetProgress() {
  window.clearTimeout(progressResetTimer);
  progressPanel.hidden = true;
  progressPanel.setAttribute('aria-valuenow', '0');
  progressFill.style.width = '0%';
  progressValue.textContent = '0%';
  progressStage.textContent = 'Checking video…';
  progressSteps.forEach((step) => step.classList.remove('active', 'complete'));
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

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
