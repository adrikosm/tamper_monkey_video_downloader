<div align="center">

# OmniFetch

**Monolithic userscript for downloading direct media, HLS, DASH, and blob/MSE video streams from modern web players.**

</div>

## Overview
OmniFetch is a Tampermonkey userscript that adds a download workflow to sites that expose media through direct file URLs, adaptive streaming manifests, or blob-based `MediaSource` playback.

The project is intentionally **monolithic**. The entire runtime lives in a single userscript file, [omnifetch.js](./omnifetch.js), so installation and audit are straightforward.

Current script version: `27.1`

## What OmniFetch Does
OmniFetch combines several download strategies behind one floating UI:

- Direct media download for normal `video` sources.
- Real HLS support:
  - master playlist parsing
  - variant selection
  - init-segment handling for fMP4
  - audio rendition downloads
- Real DASH support:
  - `BaseURL`
  - `SegmentTemplate`
  - `SegmentTimeline`
  - `SegmentList`
  - representation selection
- MSE/blob capture for players that never expose a direct file URL.
- Optional FFmpeg.wasm mux/remux when separate audio and video tracks need to be combined.
- Large direct and segmented downloads now prefer bounded-memory or disk-streaming paths instead of assembling unbounded blobs in memory.
- Site-specific extraction for:
  - Telegram
  - Reddit
  - Twitter / X
  - Facebook
  - Instagram
  - TikTok
  - Vimeo
  - generic HTML5 players

## Telegram Support
Telegram is a first-class target in OmniFetch.

The Telegram module supports:

- direct media-viewer downloads when Telegram exposes a normal URL
- blob/MSE captures for Telegram Web players that stream through `MediaSource`
- separate audio + video track capture and muxing when both tracks exist
- long-form blob stream warnings when the MSE capture limit is reached
- correct rebinding of the download button as you switch media inside Telegram's viewer

If Telegram feeds one interleaved track, OmniFetch downloads that single track directly.
If Telegram feeds separate audio and video tracks, OmniFetch tries to mux them. If muxing fails, it falls back to downloading the tracks separately with the correct container extensions.

## Security Posture
OmniFetch is broad by design, but the current build is hardened compared with a typical userscript downloader.

Security defaults and controls:

- `Strict security mode` is enabled by default.
- Third-party service routes are opt-in and disabled in strict mode.
- The optional 3rd-party YouTube converter is disabled by default.
- The optional Reddit RapidSave route is disabled by default.
- Remote FFmpeg assets are hash-verified before execution.
- Unsafe or invalid non-HTTP(S) download URLs are blocked.
- Sniffed manifest URLs are capped in memory.
- Debug report copying redacts URLs and query strings by default.
- Per-site enable/disable is available from the settings panel.
- Large direct files and large HLS/DASH downloads are forced onto safe paths that avoid unbounded memory growth.

Important scope note:

- OmniFetch runs with `@match *://*/*` and `@connect *` because universal media downloading requires access across many sites and CDNs.
- The normal direct/HLS/DASH/MSE paths do **not** upload your media to a remote service.
- The only third-party service paths are the optional YouTube converter and the optional Reddit RapidSave route, and both are opt-in.

## What OmniFetch Cannot Guarantee
There are browser-level limits that no normal userscript can honestly claim to bypass in every case.

OmniFetch does **not** guarantee support for:

- DRM / EME protected streams
- encrypted HLS streams that require decryption keys outside the page context
- sites that deliberately prevent all usable media access outside protected playback pipelines
- browser environments that do not expose a safe disk-write path for very large segmented downloads

For long blob captures, OmniFetch now uses a disk-backed temporary spool when the browser exposes OPFS support. If that spool path is unavailable, OmniFetch falls back to the configured in-memory capture cap and may only export a partial capture.

## Browser Requirement
You need a userscript manager. Tampermonkey is the recommended target.

For multi-gigabyte blob/MSE capture, the practical target is a Chromium-based browser that supports the Origin Private File System (OPFS). On browsers without that storage path, OmniFetch falls back to the configured in-memory capture limit for blob streams.

Official Tampermonkey browser pages and store links:

- Chrome: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Microsoft Edge: [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)
- Firefox: [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
- Safari: [App Store](https://apps.apple.com/us/app/tampermonkey/id6738342400)
- Opera: [Opera Add-ons](https://addons.opera.com/en/extensions/details/tampermonkey-beta/)
- Official Tampermonkey site: [tampermonkey.net](https://www.tampermonkey.net/)

For Brave, Vivaldi, Arc, and other Chromium-based browsers, use the Chrome Web Store installation.

## How to Install OmniFetch
### 1. Local file install
1. Install Tampermonkey.
2. Open the Tampermonkey dashboard.
3. Drag and drop [omnifetch.js](./omnifetch.js) into the dashboard.
4. Confirm the install.

### 2. Install from a raw URL
If you publish this repository, Tampermonkey can install directly from the raw script URL.

Example format:

```text
https://raw.githubusercontent.com/<your-username>/<your-repo>/main/omnifetch.js
```

### 3. Copy / paste install
1. Create a new script inside Tampermonkey.
2. Replace the template with the contents of [omnifetch.js](./omnifetch.js).
3. Save the script.

## How to Use
### Generic sites
1. Open a page with playable media.
2. Start playback.
3. Let OmniFetch resolve the best route.
4. Use the floating download button.

Button behavior depends on the detected route:

- direct file: downloads directly
- HLS: downloads segments and assembles them
- DASH: downloads the selected representation and assembles it
- blob/MSE: captures and exports the active buffered stream
- sniffed manifest only: asks for confirmation before using a network-sniffed HLS/DASH route

For blob/MSE routes, the floating UI now shows a live capture status pill with storage mode and exact byte count:

- `OPFS`: disk-backed temporary capture
- `MEMORY`: fallback in-memory capture
- `MIXED`: tracks are using different backing modes

For very large direct, HLS, or DASH downloads, OmniFetch now prefers disk-streaming or bounded-memory flows.
If a route would exceed the safe in-memory limit and the browser cannot stream the file safely to disk, OmniFetch fails closed instead of exhausting memory.

### Telegram
1. Open Telegram Web and play the target media.
2. In the media viewer, use the Telegram download button injected by OmniFetch.
3. For blob/MSE playback, let the media finish loading whenever possible.
4. If the stream uses separate audio and video tracks, OmniFetch will try to mux them.

For long blob streams, OmniFetch now prefers disk-backed capture. If the browser cannot provide that path, the configured fallback capture cap still applies and OmniFetch warns that the export may be partial.

## Settings Panel
Use the floating gear button to configure the script for the current site and browser session.

Available settings include:

- enable or disable OmniFetch on the current site
- toggle platform modules
- enable or disable MSE capture
- enable or disable network sniffing
- strict security mode
- auto-download completed MSE captures
- HLS concurrency
- MSE memory cap
- sniffed URL cap
- retry count and request timeout
- risky options such as iframe sandbox removal, Reddit via RapidSave, or the 3rd-party YouTube converter

## Troubleshooting
### No download button appears
- Start playback first.
- Check whether OmniFetch is disabled for the current site.
- Open the settings panel and confirm that the relevant module is enabled.

### Telegram blob download is missing audio or video
- Let the media play long enough for both tracks to be buffered.
- If the capture limit warning appears, increase the MSE memory cap and retry.
- If muxing fails, OmniFetch will fall back to separate track downloads.

### HLS or DASH download fails
- Some manifests are encrypted or intentionally protected.
- Some sites rotate tokens quickly or require request headers that expire mid-download.
- Very large segmented downloads with separate audio/video tracks may be saved as separate files instead of being muxed in-browser.
- Open the debug report from the settings panel to inspect the detected route and recent logs.

### Very large downloads
- Direct media downloads should handle multi-gigabyte files through Tampermonkey `GM_download`.
- Large HLS and DASH downloads use disk-streaming when the browser supports the File System Access API.
- On Chromium-class browsers with OPFS support, OmniFetch can spool very large blob/MSE captures to temporary browser storage instead of holding them in JS memory.
- On supported browser paths, OmniFetch is now designed to handle downloads up to roughly `10 GB` without assembling the entire file in memory.
- Very large split audio/video blob captures may still download as separate files when in-browser muxing would exceed safe FFmpeg memory limits.
- If the browser cannot provide a safe disk-write path, OmniFetch now aborts large in-memory assembly instead of risking runaway memory or swap usage.

### FFmpeg does not load
- The FFmpeg path only loads when mux/remux is needed.
- If network policy or CSP blocks it, mux/remux may fail and OmniFetch will fall back where possible.

### Reddit download opens a settings warning
- OmniFetch will use direct Reddit routes when it can.
- RapidSave is now an explicit opt-in fallback because it sends the Reddit URL to a third-party service.
- Enable it only if you want that external route.

## Project Structure
This repository is intentionally minimal.

- [omnifetch.js](./omnifetch.js): the full monolithic userscript
- [README.md](./README.md): project documentation
- [.gitignore](./.gitignore): editor, OS, and local artifact ignores

## Development Notes
OmniFetch is currently a userscript-first project rather than a packaged application.

Practical implications:

- there is no build pipeline required to run it
- the script is meant to stay monolithic
- linting and formatting can be run directly against [omnifetch.js](./omnifetch.js)
- the settings UI is stored through Tampermonkey `GM_*` storage

## Maintainer
- Andreas Mavropoulos
