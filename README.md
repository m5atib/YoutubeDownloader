# Sounddrop

A small web app that turns a public YouTube video into a high-quality MP3 download.

## Live demo

[Open Sounddrop](https://youtubedownloader-55me.onrender.com)

[![Sounddrop YouTube-to-MP3 interface](output/playwright/sounddrop-live.png)](https://youtubedownloader-55me.onrender.com)

## Run locally

Requirements: Node.js 20+ and Python 3.9+.

```bash
npm install
npm run dev
```

Then open [http://localhost:8787](http://localhost:8787).

The app bundles FFmpeg through `ffmpeg-static`. During `npm install`, `youtube-dl-exec` installs its supported `yt-dlp` binary, so no separate media tools are needed.

## Tests

```bash
npm test
```

## Notes

- Only public HTTPS YouTube URLs are accepted.
- Playlists are intentionally limited to one video.
- Videos longer than two hours are rejected to keep resource usage bounded.
- Only download content you own or have permission to use, and follow YouTube's terms and applicable law.
