<div align="center">

# OmniFetch

**Monolithic userscript for downloading direct media, HLS, DASH, and blob/MSE video streams from modern web players.**

</div>

## Overview
OmniFetch is a Tampermonkey userscript that adds a download workflow to sites that expose media through direct file URLs, adaptive streaming manifests, or blob-based `MediaSource` playback.

The project is intentionally **monolithic**. The entire runtime lives in a single userscript file, [omnifetch.js](./omnifetch.js), so installation and audit are straightforward.

Current script version: `26.6`

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
- The optional 3rd-party YouTube converter is disabled by default.
- Remote FFmpeg assets are hash-verified before execution.
- Unsafe or invalid non-HTTP(S) download URLs are blocked.
- Sniffed manifest URLs are capped in memory.
- Per-site enable/disable is available from the settings panel.

Important scope note:

- OmniFetch runs with `@match *://*/*` and `@connect *` because universal media downloading requires access across many sites and CDNs.
- The normal direct/HLS/DASH/MSE paths do **not** upload your media to a remote service.
- The only remote service path is the optional YouTube 3rd-party converter, and it remains opt-in.

## What OmniFetch Cannot Guarantee
There are browser-level limits that no normal userscript can honestly claim to bypass in every case.

OmniFetch does **not** guarantee support for:

- DRM / EME protected streams
- encrypted HLS streams that require decryption keys outside the page context
- sites that deliberately prevent all usable media access outside protected playback pipelines
- extremely long blob/MSE sessions that exceed the configured in-memory capture cap

For long blob captures, OmniFetch now warns before downloading a partial capture instead of silently pretending it is complete.

## Browser Requirement
You need a userscript manager. Tampermonkey is the recommended target.

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

### Telegram
1. Open Telegram Web and play the target media.
2. In the media viewer, use the Telegram download button injected by OmniFetch.
3. For blob/MSE playback, let the media finish loading whenever possible.
4. If the stream uses separate audio and video tracks, OmniFetch will try to mux them.

For long blob streams, if the capture limit is reached, OmniFetch warns that the download may be partial.

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
- risky options such as iframe sandbox removal or the 3rd-party YouTube converter

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
- Open the debug report from the settings panel to inspect the detected route and recent logs.

### FFmpeg does not load
- The FFmpeg path only loads when mux/remux is needed.
- If network policy or CSP blocks it, mux/remux may fail and OmniFetch will fall back where possible.

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
