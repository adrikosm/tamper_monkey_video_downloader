<div align="center">

# OmniFetch

**Universal media downloader userscript for modern web players.**

</div>

## Overview
OmniFetch is a Tampermonkey userscript that detects playable media on web pages and gives you a direct download flow.

The script includes:
- Site-aware extraction for platforms like Telegram, Reddit, Twitter/X, Instagram, TikTok, Vimeo, Facebook, and generic HTML5 players.
- Real HLS (`.m3u8`) playlist parsing and segment download.
- Real DASH (`.mpd`) parsing with representation selection and segment assembly.
- MSE (Media Source Extensions) interception for blob-based players.
- Optional FFmpeg.wasm mux/remux to produce cleaner MP4 output when video/audio are split.
- Per-site and per-module settings UI with cancel/debug controls.

## Requirements
- A browser with a userscript manager.
- [Tampermonkey](https://www.tampermonkey.net/) (recommended).

## Tampermonkey Links By Browser
- Chrome: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Microsoft Edge: [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)
- Firefox: [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
- Safari (macOS / iOS): [App Store](https://apps.apple.com/us/app/tampermonkey/id6738342400)
- Opera: [Opera Add-ons](https://addons.opera.com/en/extensions/details/tampermonkey-beta/)

For Brave and other Chromium browsers, use the Chrome Web Store link.

## Ways To Add OmniFetch
### 1) Local File Install (fastest)
1. Install Tampermonkey for your browser.
2. Open Tampermonkey Dashboard.
3. Drag and drop [`omnifetch.js`](./omnifetch.js) into the dashboard.
4. Click **Install**.

### 2) Install From Raw GitHub URL
1. Host `omnifetch.js` in a GitHub repository.
2. Open the raw file URL in your browser. Tampermonkey will prompt installation.

Current raw URL format:
```text
https://raw.githubusercontent.com/<your-username>/<your-repo>/main/omnifetch.js
```

If your repo name is `omnifetch`, it becomes:
```text
https://raw.githubusercontent.com/<your-username>/omnifetch/main/omnifetch.js
```

### 3) Copy/Paste Install
1. Open Tampermonkey Dashboard.
2. Click **Create a new script**.
3. Replace template code with the contents of `omnifetch.js`.
4. Save (`Cmd/Ctrl + S`).

## How To Use
1. Open a page with playable media.
2. Start playback so OmniFetch can resolve the best source.
3. Use the floating **download** button.
4. Use the **gear** button for settings:
   - Enable/disable OmniFetch on current site.
   - Toggle platform modules (Telegram, YouTube, Twitter/X, Reddit).
   - Control MSE capture, network sniffing, retries, and concurrency.

## Supported Download Paths
- Direct media URL download.
- HLS playlists (master/variant playlists, fMP4 init segments, audio rendition handling).
- DASH manifests (BaseURL, SegmentTemplate, SegmentTimeline, SegmentList).
- Blob/MSE captures with optional muxing.
- Telegram-specific download helpers for media viewer flows.

## Limitations
- DRM-protected/encrypted streams cannot be downloaded.
- YouTube uses an optional third-party flow (disabled by default).
- FFmpeg.wasm is loaded from CDN when needed; strict CSP/network blocks can prevent mux/remux.

## Security Notes
This userscript currently runs on all sites (`@match *://*/*`) and requests broad network access (`@connect *`) to support cross-CDN media requests.

Only install scripts you trust and review code before enabling in your primary browser profile.

## Development
This repository is intentionally simple:
- [`omnifetch.js`](./omnifetch.js): full userscript source
- [`.gitignore`](./.gitignore): ignores OS/editor/dependency artifacts

## Contributor
- **andreasmavropoulos** (only contributor)
