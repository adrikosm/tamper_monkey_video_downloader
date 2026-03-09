// ==UserScript==
// @name         OmniFetch
// @namespace    http://tampermonkey.net/
// @version      27.1
// @description  Universal video downloader with real HLS/DASH support, FFmpeg muxing, MSE interception, network sniffing, and per-site settings. Supports Reddit, Twitter/X, Facebook, Instagram, TikTok, Vimeo, Telegram, and any HTML5 video player.
// @author       adrikosm
// @match        *://*/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// ==/UserScript==

// NOTE: @require for FFmpeg removed — it is now lazy-loaded only when muxing is needed.
// NOTE: @connect * is required for universal media downloading across CDNs.
//       A per-site enable/disable toggle is provided in the settings panel.

(function () {
  "use strict";

  const SCRIPT_VERSION = "27.1";
  const HOST = window.location.hostname;
  const SETTINGS_STORAGE_KEY = "omnifetch_settings";
  const uWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const DEFAULT_MSE_MEMORY_MB = 1024;
  const MIN_MSE_MEMORY_MB = 128;
  const HARD_MAX_MSE_MEMORY_MB = 2048;
  const MAX_IN_MEMORY_DOWNLOAD_BYTES = 512 * 1024 * 1024;
  const MAX_MSE_SPOOL_PENDING_BYTES = 64 * 1024 * 1024;
  const MAX_FFMPEG_INPUT_BYTES = 768 * 1024 * 1024;
  const LARGE_SEGMENT_COUNT_THRESHOLD = 400;
  const DIRECT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
  const TARGET_LARGE_DOWNLOAD_BYTES = 10 * 1024 * 1024 * 1024;
  const BLOB_URL_REVOKE_DELAY_MS = 15 * 60 * 1000;
  const MSE_SPOOL_WORKER_SOURCE = String.raw`
    const state = {
      root: null,
      tracks: new Map(),
    };

    function sanitizeId(value) {
      return String(value || "track").replace(/[^a-zA-Z0-9._-]/g, "_");
    }

    function buildTrackName(sessionId, kind) {
      return "omnifetch_" + sanitizeId(sessionId) + "__" + sanitizeId(kind) + ".bin";
    }

    async function ensureRoot() {
      if (!self.navigator || !self.navigator.storage || typeof self.navigator.storage.getDirectory !== "function") {
        throw new Error("OPFS unavailable");
      }
      if (!state.root) {
        state.root = await self.navigator.storage.getDirectory();
      }
      return state.root;
    }

    async function ensureTrack(sessionId, kind) {
      const key = sessionId + "::" + kind;
      let track = state.tracks.get(key);
      if (!track) {
        track = {
          fileHandle: null,
          key,
          kind,
          offset: 0,
          sessionId,
          syncHandle: null,
        };
        state.tracks.set(key, track);
      }

      const root = await ensureRoot();
      if (!track.fileHandle) {
        track.fileHandle = await root.getFileHandle(buildTrackName(sessionId, kind), {
          create: true,
        });
      }
      if (!track.syncHandle) {
        track.syncHandle = await track.fileHandle.createSyncAccessHandle();
        track.offset = track.syncHandle.getSize();
      }
      return track;
    }

    async function closeTrack(track) {
      if (!track || !track.syncHandle) {
        return;
      }
      try {
        track.syncHandle.flush();
      } catch {}
      try {
        track.syncHandle.close();
      } catch {}
      track.syncHandle = null;
    }

    async function resetTrack(sessionId, kind) {
      const track = await ensureTrack(sessionId, kind);
      track.syncHandle.truncate(0);
      track.syncHandle.flush();
      track.offset = 0;
      return { size: 0 };
    }

    async function appendTrack(sessionId, kind, buffer) {
      const track = await ensureTrack(sessionId, kind);
      const bytes = new Uint8Array(buffer);
      let written = 0;
      while (written < bytes.byteLength) {
        written += track.syncHandle.write(bytes.subarray(written), {
          at: track.offset + written,
        });
      }
      track.offset += written;
      if (track.offset % (8 * 1024 * 1024) < written) {
        track.syncHandle.flush();
      }
      return { bytes: written, size: track.offset };
    }

    async function snapshotTrack(sessionId, kind) {
      const track = await ensureTrack(sessionId, kind);
      await closeTrack(track);
      const file = await track.fileHandle.getFile();
      return {
        file,
        size: file.size,
      };
    }

    async function deleteTrack(sessionId, kind) {
      const key = sessionId + "::" + kind;
      const track = state.tracks.get(key);
      if (track) {
        await closeTrack(track);
        state.tracks.delete(key);
      }

      try {
        const root = await ensureRoot();
        await root.removeEntry(buildTrackName(sessionId, kind));
      } catch {}

      return true;
    }

    async function releaseSession(sessionId) {
      await deleteTrack(sessionId, "video");
      await deleteTrack(sessionId, "audio");
      return true;
    }

    async function ping() {
      const root = await ensureRoot();
      const probeHandle = await root.getFileHandle("__omnifetch_probe__", {
        create: true,
      });
      const syncHandle = await probeHandle.createSyncAccessHandle();
      syncHandle.truncate(0);
      syncHandle.flush();
      syncHandle.close();
      try {
        await root.removeEntry("__omnifetch_probe__");
      } catch {}
      return { ok: true };
    }

    self.onmessage = async (event) => {
      const message = event.data || {};
      const id = message.id;
      const payload = message.payload || {};

      try {
        let result = null;
        switch (message.type) {
          case "appendTrack":
            result = await appendTrack(payload.sessionId, payload.kind, payload.buffer);
            break;
          case "ping":
            result = await ping();
            break;
          case "releaseSession":
            result = await releaseSession(payload.sessionId);
            break;
          case "resetTrack":
            result = await resetTrack(payload.sessionId, payload.kind);
            break;
          case "snapshotTrack":
            result = await snapshotTrack(payload.sessionId, payload.kind);
            break;
          default:
            throw new Error("Unknown spool worker message: " + message.type);
        }
        self.postMessage({
          id,
          ok: true,
          result,
        });
      } catch (error) {
        self.postMessage({
          error: error && error.message ? error.message : String(error),
          id,
          ok: false,
        });
      }
    };
  `;

  // =========================================================================
  // SECTION 0: SETTINGS & CONFIGURATION
  // =========================================================================

  const DEFAULT_SETTINGS = {
    autoDownloadMSE: false, // Auto-trigger MSE download when stream completes
    dashConcurrency: 4, // Parallel DASH segment downloads
    enableMSECapture: true, // MSE buffer interception
    enableNetworkSniff: true, // fetch/XHR hook for manifest detection
    enableReddit: true, // Reddit extraction / routing
    enableThirdPartyReddit: false, // Reddit via RapidSave (opt-in)
    enableTelegram: true, // Telegram download module
    enableThirdPartyYT: false, // YouTube via external converter (opt-in)
    enableTwitter: true, // Twitter/X video extraction
    enableYouTube: true, // YouTube download routing
    enabled: true, // Master switch
    enabledSites: {}, // Per-host overrides: { "example.com": false }
    hlsConcurrency: 4, // Parallel HLS segment downloads
    logLevel: "info", // 'debug' | 'info' | 'warn' | 'error'
    maxMSEMemoryMB: DEFAULT_MSE_MEMORY_MB, // Hard cap on MSE buffer capture (MB)
    maxRetries: 2, // Retry count on network failure
    maxSniffedUrls: 200, // Cap sniffed manifests kept in memory
    removeIframeSandbox: false, // Removes iframe sandbox attributes (risky)
    requestTimeoutBlob: 60000, // Timeout for blob/binary fetches (ms)
    requestTimeoutText: 15000, // Timeout for text/json fetches (ms)
    rescanIntervalMs: 5000, // Fallback rescan interval
    strictSecurityMode: true, // Blocks risky features by default
  };

  function loadSettings() {
    const baseSettings = {
      ...DEFAULT_SETTINGS,
      enabledSites: { ...DEFAULT_SETTINGS.enabledSites },
    };

    try {
      const saved = GM_getValue(SETTINGS_STORAGE_KEY, null);
      if (!saved) {
        return baseSettings;
      }

      const parsed = JSON.parse(saved);
      return {
        ...baseSettings,
        ...parsed,
        enabledSites: {
          ...baseSettings.enabledSites,
          ...(parsed.enabledSites || {}),
        },
      };
    } catch {
      return baseSettings;
    }
  }

  let settings = loadSettings();

  function saveSettings() {
    try {
      GM_setValue(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors in restricted userscript contexts.
    }
  }

  function readIntegerInput(id, fallbackValue, minValue, maxValue) {
    const input = document.getElementById(id);
    const parsedValue = parseInt(input?.value || "", 10);
    const safeValue = Number.isFinite(parsedValue)
      ? parsedValue
      : fallbackValue;
    return Math.max(minValue, Math.min(maxValue, safeValue));
  }

  function syncLegacyCompatFlags() {
    // Compatibility flags are mirrored out for inspection only.
    uWindow.autoDownload = settings.autoDownloadMSE ? 1 : 0;
    if (typeof uWindow.downloadAll !== "number") {
      uWindow.downloadAll = 0;
    }
    if (typeof uWindow.quickPlay !== "number") {
      uWindow.quickPlay = 1.0;
    }
  }

  function isStrictSecurityMode() {
    return settings.strictSecurityMode !== false;
  }

  function enforceSecurityPolicy() {
    settings.maxMSEMemoryMB = Math.max(
      MIN_MSE_MEMORY_MB,
      Math.min(
        HARD_MAX_MSE_MEMORY_MB,
        parseInt(settings.maxMSEMemoryMB, 10) || DEFAULT_MSE_MEMORY_MB,
      ),
    );
    settings.hlsConcurrency = Math.max(
      1,
      Math.min(8, parseInt(settings.hlsConcurrency, 10) || 4),
    );
    settings.dashConcurrency = Math.max(
      1,
      Math.min(8, parseInt(settings.dashConcurrency, 10) || 4),
    );
    settings.maxRetries = Math.max(
      0,
      Math.min(5, parseInt(settings.maxRetries, 10) || 2),
    );
    settings.requestTimeoutBlob = Math.max(
      5000,
      Math.min(300000, parseInt(settings.requestTimeoutBlob, 10) || 60000),
    );
    settings.requestTimeoutText = Math.max(
      5000,
      Math.min(300000, parseInt(settings.requestTimeoutText, 10) || 15000),
    );
    settings.maxSniffedUrls = Math.max(
      20,
      Math.min(2000, parseInt(settings.maxSniffedUrls, 10) || 200),
    );
    if (isStrictSecurityMode()) {
      settings.enableThirdPartyReddit = false;
      settings.enableThirdPartyYT = false;
      settings.removeIframeSandbox = false;
    }
  }

  enforceSecurityPolicy();
  syncLegacyCompatFlags();

  function isSiteEnabled() {
    if (!settings.enabled) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(settings.enabledSites, HOST)) {
      return settings.enabledSites[HOST];
    }
    return true; // enabled by default unless explicitly disabled
  }

  function redactHttpUrl(rawUrl) {
    const safe = toHttpUrl(rawUrl);
    if (!safe) {
      return String(rawUrl || "");
    }
    const hasQuery = safe.search.length > 0;
    const hasHash = safe.hash.length > 0;
    return (
      `${safe.origin}${safe.pathname}` +
      (hasQuery ? "?[redacted]" : "") +
      (hasHash ? "#[redacted]" : "")
    );
  }

  function redactUrlForReport(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      return String(rawUrl || "");
    }

    const trimmed = rawUrl.trim();
    if (trimmed.startsWith("reddit:")) {
      return `reddit:${redactUrlForReport(trimmed.slice("reddit:".length))}`;
    }
    if (trimmed.startsWith("sniff:")) {
      return `sniff:${redactUrlForReport(trimmed.slice("sniff:".length))}`;
    }
    if (trimmed.startsWith("blob:")) {
      return "blob:[redacted]";
    }
    return redactHttpUrl(trimmed);
  }

  function redactSensitiveText(text) {
    return String(text || "")
      .replace(/reddit:[^\s"'`<>]+/g, (match) => redactUrlForReport(match))
      .replace(/sniff:[^\s"'`<>]+/g, (match) => redactUrlForReport(match))
      .replace(/blob:[^\s"'`<>]+/g, (match) => redactUrlForReport(match))
      .replace(/https?:\/\/[^\s"'`<>]+/g, (match) => redactUrlForReport(match));
  }

  // =========================================================================
  // SECTION 1: STRUCTURED LOGGER WITH RING BUFFER
  // =========================================================================

  const LOG_LEVELS = { debug: 0, error: 3, info: 1, warn: 2 };
  const LOG_RING_SIZE = 200; // Keep last 200 entries for diagnostics
  const logRing = [];

  const Log = {
    _emit(level, ...args) {
      const entry = {
        ts: new Date().toISOString(),
        level,
        msg: args
          .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
          .join(" "),
      };
      logRing.push(entry);
      if (logRing.length > LOG_RING_SIZE) {
        logRing.shift();
      }
      if (LOG_LEVELS[level] >= LOG_LEVELS[settings.logLevel]) {
        const fn =
          level === "error"
            ? console.error
            : level === "warn"
              ? console.warn
              : console.log;
        fn(`[OmniFetch][${level.toUpperCase()}]`, ...args);
      }
    },
    debug(...a) {
      this._emit("debug", ...a);
    },
    info(...a) {
      this._emit("info", ...a);
    },
    warn(...a) {
      this._emit("warn", ...a);
    },
    error(...a) {
      this._emit("error", ...a);
    },
    exportReport() {
      return [
        `OmniFetch v${SCRIPT_VERSION} Debug Report — ${new Date().toISOString()}`,
        `URL: ${redactUrlForReport(window.location.href)}`,
        `UA: ${navigator.userAgent}`,
        `Settings: ${JSON.stringify(settings, null, 2)}`,
        `Active source: ${redactUrlForReport(activeVideoSrc || "none")}`,
        `Sniffed URLs: ${JSON.stringify(
          sniffedManifestUrls.map((url) => redactUrlForReport(url)),
        )}`,
        `MSE state: video=${getMSETrackChunkCount(uWindow.__omnifetch, "video")} chunks (${formatBytes(getMSETrackByteCount(uWindow.__omnifetch, "video"))}, ${getMSETrackStorageMode(uWindow.__omnifetch, "video")}), audio=${getMSETrackChunkCount(uWindow.__omnifetch, "audio")} chunks (${formatBytes(getMSETrackByteCount(uWindow.__omnifetch, "audio"))}, ${getMSETrackStorageMode(uWindow.__omnifetch, "audio")}), complete=${uWindow.__omnifetch?.mseComplete}`,
        `------- LOG (last ${logRing.length} entries) -------`,
        ...logRing.map(
          (e) => `[${e.ts}][${e.level}] ${redactSensitiveText(e.msg)}`,
        ),
      ].join("\n");
    },
  };

  // =========================================================================
  // MODULE A: TELEGRAM NATIVE BYPASS
  // =========================================================================

  let isTelegramMode = false;

  if (HOST.includes("telegram.org") && settings.enableTelegram) {
    Log.info("Deploying Telegram SPA Bypass Module...");
    const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+)$/;
    const REFRESH_DELAY = 500;
    const hashCode = (s) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      }
      return h >>> 0;
    };

    const createProgressBar = (videoId, fileName) => {
      const isDarkMode =
        document.querySelector("html")?.classList.contains("night") ||
        document.querySelector("html")?.classList.contains("theme-dark");
      const container = document.getElementById(
        "tel-downloader-progress-bar-container",
      );
      if (!container) {
        return;
      }
      const inner = document.createElement("div");
      inner.id = "tel-downloader-progress-" + videoId;
      inner.style.cssText = `width:20rem;margin-top:0.4rem;padding:0.6rem;background:${isDarkMode ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.6)"}`;
      const flex = document.createElement("div");
      flex.style.cssText = "display:flex;justify-content:space-between";
      const title = document.createElement("p");
      title.className = "filename";
      title.style.cssText = "margin:0;color:white";
      title.textContent = fileName;
      const closeBtn = document.createElement("div");
      closeBtn.style.cssText = `cursor:pointer;font-size:1.2rem;color:${isDarkMode ? "#8a8a8a" : "white"}`;
      closeBtn.innerHTML = "&times;";
      closeBtn.onclick = () => inner.remove();
      const bar = document.createElement("div");
      bar.className = "progress";
      bar.style.cssText =
        "background:#e2e2e2;position:relative;width:100%;height:1.6rem;border-radius:2rem;overflow:hidden";
      const counter = document.createElement("p");
      counter.style.cssText =
        "position:absolute;z-index:5;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;color:black";
      const fill = document.createElement("div");
      fill.style.cssText =
        "position:absolute;height:100%;width:0%;background:#6093B5";
      bar.append(counter, fill);
      flex.append(title, closeBtn);
      inner.append(flex, bar);
      container.appendChild(inner);
    };
    const updateProgress = (videoId, fileName, pct) => {
      const el = document.getElementById("tel-downloader-progress-" + videoId);
      if (!el) {
        return;
      }
      el.querySelector("p.filename").textContent = fileName;
      const bar = el.querySelector("div.progress");
      bar.querySelector("p").textContent = pct + "%";
      bar.querySelector("div").style.width = pct + "%";
    };
    const setProgressState = (videoId, label, color, width = "100%") => {
      const bar = document
        .getElementById("tel-downloader-progress-" + videoId)
        ?.querySelector("div.progress");
      if (!bar) {
        return;
      }
      bar.querySelector("p").textContent = label;
      bar.querySelector("div").style.cssText +=
        `;background:${color};width:${width}`;
    };
    const completeProgress = (videoId) => {
      setProgressState(videoId, "Completed", "#B6C649");
    };
    const partialProgress = (videoId) => {
      setProgressState(videoId, "Downloaded (partial)", "#E6A23C");
    };
    const abortProgress = (videoId) => {
      setProgressState(videoId, "Aborted", "#D16666");
    };

    const confirmPartialMSEDownload = (of, label = "This stream") => {
      if (!of.captureLimitReached) {
        return true;
      }
      const capturedMb = Math.round(
        ((of.totalVideoBytes || 0) + (of.totalAudioBytes || 0)) / 1048576,
      );
      return confirm(
        `${label} exceeded the OmniFetch MSE capture limit.\n\nCaptured so far: ${capturedMb} MB\nCapture cap: ${settings.maxMSEMemoryMB} MB\n\nDownload the partial capture anyway?`,
      );
    };

    const tel_download_video = (url) => {
      // If the URL is a blob: (MediaSource/MSE stream), we can't range-request it.
      // Use MSE-captured chunks which contain the full muxed audio+video data.
      if (url && isBlobUrl(url)) {
        return tel_download_mse_video(url);
      }
      // Direct URL: download via range requests
      const blobs = [];
      let nextOffset = 0,
        totalSize = null,
        ext = "mp4",
        mimeType = "video/mp4";
      let bufferedBytes = 0;
      const videoId =
        Math.random().toString(36).slice(2, 10) + "_" + Date.now();
      let fileName = hashCode(url).toString(36) + "." + ext;
      try {
        const meta = JSON.parse(decodeURIComponent(url.split("/").pop()));
        if (meta.fileName) {
          fileName = meta.fileName;
        }
      } catch {
        // Keep generated fallback filename.
      }
      const fetchPart = (writable) => {
        fetch(url, {
          method: "GET",
          headers: { Range: `bytes=${nextOffset}-` },
        })
          .then((res) => {
            if (![200, 206].includes(res.status)) {
              throw new Error("HTTP " + res.status);
            }
            const mime = (res.headers.get("Content-Type") || "video/mp4").split(
              ";",
            )[0];
            if (mime.startsWith("video/")) {
              ext = getMimeExtension(mime, mime.split("/")[1]);
              mimeType = mime;
              fileName = fileName.replace(/\.[^.]+$/, "." + ext);
            }
            const range = (res.headers.get("Content-Range") || "").match(
              contentRangeRegex,
            );
            if (range) {
              if (parseInt(range[1], 10) !== nextOffset) {
                throw new Error("Gap detected");
              }
              nextOffset = parseInt(range[2], 10) + 1;
              totalSize = parseInt(range[3], 10);
              if (!writable && totalSize > MAX_IN_MEMORY_DOWNLOAD_BYTES) {
                throw new Error(
                  `Telegram direct download is ${formatBytes(totalSize)}, which exceeds OmniFetch's safe in-memory limit on browsers without disk streaming.`,
                );
              }
              updateProgress(
                videoId,
                fileName,
                ((nextOffset * 100) / totalSize).toFixed(0),
              );
            }
            return res.blob();
          })
          .then((blob) => {
            if (writable) {
              return writable.write(blob);
            }
            bufferedBytes += blob.size;
            if (bufferedBytes > MAX_IN_MEMORY_DOWNLOAD_BYTES) {
              throw new Error(
                `Telegram direct download exceeded OmniFetch's safe in-memory limit (${formatBytes(MAX_IN_MEMORY_DOWNLOAD_BYTES)}).`,
              );
            }
            blobs.push(blob);
            return null;
          })
          .then(() => {
            if (totalSize && nextOffset < totalSize) {
              fetchPart(writable);
            } else {
              if (writable) {
                writable.close();
              } else {
                const blobUrl = URL.createObjectURL(
                  new Blob(blobs, { type: mimeType }),
                );
                const a = document.createElement("a");
                a.href = blobUrl;
                a.setAttribute("download", fileName);
                a.style.display = "none";
                document.body.appendChild(a);
                setTimeout(() => {
                  a.click();
                  setTimeout(() => {
                    a.remove();
                    URL.revokeObjectURL(blobUrl);
                  }, 15000);
                }, 100);
              }
              completeProgress(videoId);
            }
          })
          .catch((e) => {
            Log.error("Telegram download failed:", e.message);
            abortProgress(videoId);
          });
      };
      const supportsFS =
        "showSaveFilePicker" in uWindow &&
        (() => {
          try {
            return uWindow.self === uWindow.top;
          } catch {
            return false;
          }
        })();
      if (supportsFS) {
        uWindow
          .showSaveFilePicker({ suggestedName: fileName })
          .then((h) =>
            h.createWritable().then((w) => {
              fetchPart(w);
              createProgressBar(videoId, fileName);
            }),
          )
          .catch((err) => {
            if (err.name !== "AbortError") {
              fetchPart(null);
              createProgressBar(videoId, fileName);
            }
          });
      } else {
        fetchPart(null);
        createProgressBar(videoId, fileName);
      }
    };

    // Download from MSE-captured chunks (handles blob: URLs where Telegram feeds audio+video via MediaSource)
    const tel_download_mse_video = async (sourceUrl = "") => {
      const of = syncActiveMSEState(sourceUrl);
      if (!of) {
        alert(
          "Video capture not ready.\nPlease wait for the video to load and try again.",
        );
        return;
      }

      const hasVideo = hasMSETrackData(of, "video");
      const hasAudio = hasMSETrackData(of, "audio");

      if (!hasVideo && !hasAudio) {
        alert(
          "No video data captured yet.\n\nPlease let the video play to the end, then click download again.",
        );
        return;
      }

      if (!confirmPartialMSEDownload(of, "Telegram video")) {
        return;
      }

      if (!of.mseComplete) {
        const sizeMB = Math.round(
          (of.totalVideoBytes + of.totalAudioBytes) / 1048576,
        );
        if (
          !confirm(
            "Video is still buffering (" +
              sizeMB +
              " MB captured).\n\nDownload what's available so far?",
          )
        ) {
          return;
        }
      }

      const videoId =
        Math.random().toString(36).slice(2, 10) + "_" + Date.now();
      const baseName = "telegram_video_" + Date.now();
      const muxPlan = buildMuxPlan(of.videoMime, of.audioMime);
      const outputFileName = buildMediaFilename(
        baseName,
        muxPlan.outputMime,
        muxPlan.outputExt,
      );
      createProgressBar(videoId, outputFileName);
      updateProgress(videoId, outputFileName, 50);

      try {
        let didDownload = false;
        if (hasAudio && hasVideo) {
          // Separate audio + video SourceBuffers — need to mux with FFmpeg
          // muxVideoAudio() is a function declaration (hoisted) and all its dependencies
          // are initialized by click-time because we no longer return early.
          updateProgress(videoId, outputFileName, 60);
          const videoBlob = await getMSETrackBlob(
            of,
            "video",
            sourceUrl,
            "video/mp4",
          );
          const audioBlob = await getMSETrackBlob(
            of,
            "audio",
            sourceUrl,
            "audio/mp4",
          );
          let muxed = null;
          try {
            ensureMuxFitsMemory(
              of.totalVideoBytes,
              of.totalAudioBytes,
              "Telegram MSE capture",
            );
            muxed = await muxVideoAudio(videoBlob, audioBlob, muxPlan);
          } catch (muxGuardError) {
            Log.warn(muxGuardError.message);
          }
          updateProgress(videoId, outputFileName, 90);
          if (muxed) {
            triggerBlobDownload(muxed, outputFileName);
            didDownload = true;
          } else {
            Log.warn("Telegram mux failed, downloading tracks separately");
            triggerBlobDownload(
              videoBlob,
              buildMediaFilename(
                `${baseName}_video`,
                videoBlob.type,
                muxPlan.inputVideoExt,
              ),
            );
            setTimeout(
              () =>
                triggerBlobDownload(
                  audioBlob,
                  buildMediaFilename(
                    `${baseName}_audio`,
                    audioBlob.type,
                    muxPlan.inputAudioExt,
                  ),
                ),
              500,
            );
            didDownload = true;
          }
        } else {
          // Single muxed track (typical: Telegram feeds interleaved MP4 to one SourceBuffer)
          const dominantKind = hasVideo ? "video" : "audio";
          const blob = await getMSETrackBlob(
            of,
            dominantKind,
            sourceUrl,
            dominantKind === "video" ? "video/mp4" : "audio/mp4",
          );
          triggerBlobDownload(
            blob,
            buildMediaFilename(
              baseName,
              blob.type,
              dominantKind === "video" ? "mp4" : "m4a",
            ),
          );
          didDownload = true;
        }
        if (didDownload) {
          releaseActiveMSECapture(sourceUrl);
        }
        if (of.captureLimitReached) {
          partialProgress(videoId);
        } else {
          completeProgress(videoId);
        }
      } catch (e) {
        Log.error("Telegram MSE download failed:", e.message);
        abortProgress(videoId);
        alert("Download failed: " + e.message);
      }
    };

    const tel_download_image = (url) => {
      const a = document.createElement("a");
      a.href = url;
      a.setAttribute(
        "download",
        Math.random().toString(36).slice(2, 10) + ".jpeg",
      );
      a.style.display = "none";
      document.body.appendChild(a);
      setTimeout(() => {
        a.click();
        setTimeout(() => a.remove(), 5000);
      }, 100);
    };

    const DOWNLOAD_ICON = "\ue977";
    const getTelegramViewerVideoSrc = () =>
      document.querySelector("#MediaViewer .MediaViewerContent video")
        ?.currentSrc ||
      document.querySelector("#MediaViewer .MediaViewerContent video")?.src ||
      "";
    const getTelegramViewerImageSrc = () =>
      document.querySelector("#MediaViewer .MediaViewerContent > div > img")
        ?.src || "";
    const upsertTelegramDownloadButton = () => {
      const actions = document.querySelector(
        "#MediaViewer .MediaViewerActions",
      );
      if (!actions) {
        return;
      }

      let btn = actions.querySelector("button.tel-download");
      const videoSrc = getTelegramViewerVideoSrc();
      const imageSrc = getTelegramViewerImageSrc();

      if (!videoSrc && !imageSrc) {
        btn?.remove();
        return;
      }

      if (!btn) {
        btn = document.createElement("button");
        btn.className = "Button smaller translucent-white round tel-download";
        btn.innerHTML = '<i class="icon icon-download"></i>';
        actions.prepend(btn);
      }

      if (videoSrc) {
        btn.title = "Download video";
        btn.onclick = () => tel_download_video(getTelegramViewerVideoSrc());
      } else {
        btn.title = "Download image";
        btn.onclick = () => tel_download_image(getTelegramViewerImageSrc());
      }
    };
    setInterval(() => {
      upsertTelegramDownloadButton();
    }, REFRESH_DELAY);

    setInterval(() => {
      const aspecter = document.querySelector(
        ".media-viewer-whole .media-viewer-movers .media-viewer-aspecter",
      );
      const buttons = document.querySelector(
        ".media-viewer-whole .media-viewer-topbar .media-viewer-buttons",
      );
      if (!aspecter || !buttons) {
        return;
      }
      buttons.querySelectorAll("button.btn-icon.hide").forEach((b) => {
        b.classList.remove("hide");
        if (b.textContent === DOWNLOAD_ICON) {
          b.classList.add("tgico-download");
        }
      });
      if (
        aspecter.querySelector("video") &&
        !buttons.querySelector("button.btn-icon.tgico-download")
      ) {
        const btn = document.createElement("button");
        btn.className = "btn-icon tgico-download tel-download";
        btn.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
        btn.onclick = () =>
          tel_download_video(aspecter.querySelector("video").src);
        buttons.prepend(btn);
      }
    }, REFRESH_DELAY);

    window.addEventListener("DOMContentLoaded", () => {
      const c = document.createElement("div");
      c.id = "tel-downloader-progress-bar-container";
      c.style.cssText = `position:fixed;bottom:0;right:0;z-index:${location.pathname.startsWith("/k/") ? 4 : 1600}`;
      document.body.appendChild(c);
    });
    isTelegramMode = true; // Don't return — utility code (MSE interceptor, FFmpeg, networking) still needs to initialize
  }

  // =========================================================================
  // MODULE B: LPSG PAYWALL BYPASS & DOM TRANSFORMATION
  // =========================================================================

  if (HOST.includes("lpsg.com")) {
    Log.info("Deploying LPSG Module...");
    const removeLPSGBlockers = () => {
      document
        .querySelectorAll(
          ".video-easter-egg-blocker, .video-easter-egg-overlay",
        )
        .forEach((el) => el.remove());
    };
    const transformPosters = () => {
      document
        .querySelectorAll(
          'img[src*="cdn-videos.lpsg.com/data/attachments/posters/"]',
        )
        .forEach((img) => {
          const m = img.src.match(
            /\/data\/attachments\/posters\/(\d+)\/(\d+)-([a-f0-9]+)\.jpg/,
          );
          if (m) {
            const video = document.createElement("video");
            video.src = `https://cdn-videos.lpsg.com/data/video/${m[1]}/${m[2]}-${m[3]}.mp4`;
            video.controls = true;
            video.style.width = "100%";
            img.replaceWith(video);
          }
        });
    };
    window.addEventListener("DOMContentLoaded", () => {
      removeLPSGBlockers();
      transformPosters();
    });
    new MutationObserver(() => {
      removeLPSGBlockers();
      transformPosters();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // =========================================================================
  // CHECK: Is OmniFetch enabled for this site?
  // =========================================================================

  if (!isTelegramMode && !isSiteEnabled()) {
    Log.info("OmniFetch disabled for", HOST);
    return;
  }

  Log.info(`OmniFetch v${SCRIPT_VERSION} initializing on`, HOST);

  // =========================================================================
  // SECTION 2: NETWORKING PRIMITIVES (timeout + retry + abort)
  // =========================================================================

  // Track all active GM request handles so we can abort on cancel/navigation
  const activeRequests = new Set();

  function abortAllRequests() {
    for (const handle of activeRequests) {
      try {
        if (typeof handle.abort === "function") {
          handle.abort();
        }
      } catch {
        // Ignore abort errors from stale/closed handles.
      }
    }
    activeRequests.clear();
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      let handle;
      try {
        handle = GM_xmlhttpRequest({
          ...opts,
          timeout: opts.timeout || settings.requestTimeoutText,
          onload(r) {
            if (handle) {
              activeRequests.delete(handle);
            }
            resolve(r);
          },
          onerror(e) {
            if (handle) {
              activeRequests.delete(handle);
            }
            reject(
              new Error(
                "Network error: " + (e?.statusText || e?.error || "unknown"),
              ),
            );
          },
          ontimeout() {
            if (handle) {
              activeRequests.delete(handle);
            }
            reject(
              new Error(
                "Timeout after " +
                  (opts.timeout || settings.requestTimeoutText) +
                  "ms",
              ),
            );
          },
          onprogress: opts.onprogress || undefined,
        });
      } catch (e) {
        // Some TM builds throw synchronously on bad args
        return reject(new Error("GM_xmlhttpRequest threw: " + e.message));
      }
      // Safari TM may return undefined or a non-abortable handle
      if (handle && typeof handle.abort === "function") {
        activeRequests.add(handle);
      }
    });
  }

  async function fetchText(url, retries) {
    const safeUrl = ensureHttpUrl(url, "fetchText");
    retries = retries ?? settings.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await gmRequest({
          method: "GET",
          url: safeUrl,
          headers: { Accept: "*/*" },
          timeout: settings.requestTimeoutText,
        });
        if (r.status >= 200 && r.status < 400) {
          return r.responseText;
        }
        throw new Error("HTTP " + r.status);
      } catch (e) {
        if (attempt === retries) {
          throw e;
        }
        Log.debug(
          `fetchText retry ${attempt + 1}/${retries} for ${safeUrl.substring(0, 80)}: ${e.message}`,
        );
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // backoff
      }
    }
  }

  async function fetchJSON(url, headers = {}, method = "GET") {
    const safeUrl = ensureHttpUrl(url, "fetchJSON");
    const r = await gmRequest({
      method,
      url: safeUrl,
      headers,
      timeout: settings.requestTimeoutText,
    });
    // Handle TM implementation differences: r.response may already be parsed
    if (typeof r.response === "object" && r.response !== null) {
      return r.response;
    }
    return JSON.parse(r.responseText);
  }

  async function fetchBlob(url, onProgress = null, retries) {
    const safeUrl = ensureHttpUrl(url, "fetchBlob");
    retries = retries ?? settings.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await gmRequest({
          method: "GET",
          url: safeUrl,
          responseType: "blob",
          headers: { Accept: "*/*", Referer: window.location.href },
          timeout: settings.requestTimeoutBlob,
          onprogress: onProgress
            ? (p) => {
                if (p.lengthComputable) {
                  onProgress(p.loaded, p.total);
                }
              }
            : undefined,
        });
        // Safari TM compatibility: response may be ArrayBuffer, Uint8Array, or
        // a Blob-like without .size. Normalize everything to a real Blob.
        let blob = r.response;
        if (blob instanceof ArrayBuffer) {
          blob = new Blob([blob]);
        } else if (ArrayBuffer.isView(blob)) {
          blob = new Blob([blob.buffer]);
        } else if (
          blob &&
          typeof blob === "object" &&
          !(blob instanceof Blob)
        ) {
          // Some TM builds return a plain object with arrayBuffer/text methods
          try {
            blob = new Blob([await blob.arrayBuffer()]);
          } catch {
            blob = null;
          }
        }
        if (blob && blob.size > 0) {
          return blob;
        }
        // Last resort: if responseType was silently ignored, raw text may exist
        if (r.responseText && r.responseText.length > 0) {
          const enc = new TextEncoder();
          return new Blob([enc.encode(r.responseText)]);
        }
        throw new Error("Empty response");
      } catch (e) {
        if (attempt === retries) {
          throw e;
        }
        Log.debug(`fetchBlob retry ${attempt + 1}/${retries}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  function getResponseHeader(responseHeaders, headerName) {
    const match = String(responseHeaders || "").match(
      new RegExp(`^${headerName}:\\s*(.+)$`, "im"),
    );
    return match ? match[1].trim() : "";
  }

  async function probeRemoteResource(url) {
    const safeUrl = ensureHttpUrl(url, "probeRemoteResource");
    try {
      const response = await gmRequest({
        method: "HEAD",
        url: safeUrl,
        headers: { Accept: "*/*" },
        timeout: settings.requestTimeoutText,
      });
      const length = parseInt(
        getResponseHeader(response.responseHeaders, "content-length"),
        10,
      );
      return {
        acceptRanges: /(^|\n)accept-ranges:\s*bytes/i.test(
          String(response.responseHeaders || ""),
        ),
        length: Number.isFinite(length) ? length : null,
        mime:
          getResponseHeader(response.responseHeaders, "content-type") ||
          "application/octet-stream",
      };
    } catch {
      return { acceptRanges: false, length: null, mime: "" };
    }
  }

  async function fetchBlobRange(url, start, end) {
    const safeUrl = ensureHttpUrl(url, "fetchBlobRange");
    const response = await gmRequest({
      method: "GET",
      url: safeUrl,
      responseType: "blob",
      headers: {
        Accept: "*/*",
        Range: `bytes=${start}-${end}`,
      },
      timeout: settings.requestTimeoutBlob,
    });
    let blob = response.response;
    if (blob instanceof ArrayBuffer) {
      blob = new Blob([blob]);
    } else if (ArrayBuffer.isView(blob)) {
      blob = new Blob([blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)]);
    } else if (blob && typeof blob === "object" && !(blob instanceof Blob)) {
      blob = new Blob([await blob.arrayBuffer()]);
    }
    if (!(blob instanceof Blob) || blob.size <= 0) {
      throw new Error("Range request returned no data");
    }
    return blob;
  }

  function canUseFileSystemAccess() {
    try {
      return (
        typeof uWindow.showSaveFilePicker === "function" &&
        uWindow.self === uWindow.top
      );
    } catch {
      return false;
    }
  }

  async function openWritableSaveTarget(suggestedName, mimeType) {
    if (!canUseFileSystemAccess()) {
      return null;
    }
    const cleanName = sanitizeFilenameSegment(suggestedName || "download.bin");
    const extMatch = cleanName.match(/(\.[a-z0-9]{1,8})$/i);
    const extension = extMatch ? extMatch[1] : ".bin";
    const handle = await uWindow.showSaveFilePicker({
      suggestedName: cleanName,
      types: [
        {
          accept: {
            [mimeType || "application/octet-stream"]: [extension],
          },
          description: "Media file",
        },
      ],
    });
    return handle.createWritable();
  }

  async function withSaveTarget(suggestedName, mimeType, writerFn) {
    const writable = await openWritableSaveTarget(suggestedName, mimeType);
    if (!writable) {
      return false;
    }
    let closed = false;
    try {
      const result = await writerFn(writable);
      await writable.close();
      closed = true;
      return result;
    } catch (e) {
      if (!closed && typeof writable.abort === "function") {
        try {
          await writable.abort();
        } catch {
          // Ignore abort failures after a write error.
        }
      }
      throw e;
    }
  }

  async function writeSequentialUrlsToFile(
    urls,
    suggestedName,
    mimeType,
    btn,
    dlId,
    label,
  ) {
    if (!urls.length) {
      throw new Error(`${label}: no segments to write`);
    }
    return withSaveTarget(suggestedName, mimeType, async (writable) => {
      let totalWritten = 0;
      for (let i = 0; i < urls.length; i++) {
        if (isStale(dlId)) {
          throw new Error("Download cancelled");
        }
        const blob = await fetchBlob(urls[i]);
        totalWritten += blob.size;
        await writable.write(blob);
        if (!isStale(dlId)) {
          setBtnProgress(
            btn,
            `${label} ${i + 1}/${urls.length} · ${formatBytes(totalWritten)}`,
          );
        }
      }
      return { filename: suggestedName, totalWritten };
    });
  }

  async function collectUrlsToMemory(urls, btn, dlId, label, byteLimit) {
    const blobs = [];
    let totalBytes = 0;
    for (let i = 0; i < urls.length; i++) {
      if (isStale(dlId)) {
        return { blobs: null, totalBytes };
      }
      const blob = await fetchBlob(urls[i]);
      totalBytes += blob.size;
      if (totalBytes > byteLimit) {
        throw new Error(
          `${label} exceeds the safe in-memory download limit (${formatBytes(byteLimit)}). Use a Chromium browser with File System Access support for large downloads.`,
        );
      }
      blobs.push(blob);
      if (!isStale(dlId)) {
        setBtnProgress(
          btn,
          `${label} ${i + 1}/${urls.length} · ${formatBytes(totalBytes)}`,
        );
      }
    }
    return { blobs, totalBytes };
  }

  async function estimateSegmentedDownloadBytes(urls) {
    if (!Array.isArray(urls) || urls.length === 0) {
      return null;
    }
    const sampleIndexes = [...new Set([
      0,
      Math.floor((urls.length - 1) / 2),
      urls.length - 1,
    ])];
    const sampleLengths = [];
    for (const index of sampleIndexes) {
      const sample = await probeRemoteResource(urls[index]);
      if (Number.isFinite(sample.length) && sample.length > 0) {
        sampleLengths.push(sample.length);
      }
    }
    if (sampleLengths.length === 0) {
      return null;
    }
    const average =
      sampleLengths.reduce((sum, value) => sum + value, 0) / sampleLengths.length;
    return Math.round(average * urls.length);
  }

  function shouldStreamSegmentedDownload(urls, estimatedBytes, requiresMux = false) {
    if (!canUseFileSystemAccess()) {
      return false;
    }
    if (urls.length >= LARGE_SEGMENT_COUNT_THRESHOLD) {
      return true;
    }
    if (Number.isFinite(estimatedBytes) && estimatedBytes > MAX_IN_MEMORY_DOWNLOAD_BYTES) {
      return true;
    }
    if (requiresMux && Number.isFinite(estimatedBytes) && estimatedBytes > MAX_FFMPEG_INPUT_BYTES) {
      return true;
    }
    return false;
  }

  async function maybeDownloadDirectToFile(url, suggestedName, btn, dlId) {
    const safeUrl = ensureHttpUrl(url, "maybeDownloadDirectToFile");
    if (!canUseFileSystemAccess()) {
      return false;
    }
    const probe = await probeRemoteResource(safeUrl);
    if (!probe.acceptRanges || !Number.isFinite(probe.length)) {
      return false;
    }
    if (probe.length <= MAX_IN_MEMORY_DOWNLOAD_BYTES) {
      return false;
    }
    if (probe.length > TARGET_LARGE_DOWNLOAD_BYTES) {
      Log.info(
        `Direct file exceeds ${formatBytes(TARGET_LARGE_DOWNLOAD_BYTES)}; using chunked disk write.`,
      );
    }
    await withSaveTarget(
      suggestedName,
      probe.mime || "application/octet-stream",
      async (writable) => {
        let offset = 0;
        while (offset < probe.length) {
          if (isStale(dlId)) {
            throw new Error("Download cancelled");
          }
          const end = Math.min(offset + DIRECT_CHUNK_SIZE_BYTES - 1, probe.length - 1);
          const blob = await fetchBlobRange(safeUrl, offset, end);
          await writable.write(blob);
          offset = end + 1;
          if (!isStale(dlId)) {
            setBtnProgress(
              btn,
              `${Math.round((offset / probe.length) * 100)}% · ${formatBytes(offset)}`,
            );
          }
        }
      },
    );
    return true;
  }

  function getMimeExtension(mime, fallback = "bin") {
    const normalized = String(mime || "").toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized.includes("video/mp4")) {
      return "mp4";
    }
    if (normalized.includes("audio/mp4")) {
      return "m4a";
    }
    if (normalized.includes("webm")) {
      return "webm";
    }
    if (normalized.includes("matroska")) {
      return "mkv";
    }
    if (normalized.includes("mp2t")) {
      return "ts";
    }
    if (normalized.includes("mpegurl")) {
      return "m3u8";
    }
    if (normalized.includes("aac")) {
      return "aac";
    }
    if (normalized.includes("mpeg")) {
      return normalized.startsWith("audio/") ? "mp3" : "mpeg";
    }
    if (normalized.includes("ogg")) {
      return "ogg";
    }
    if (normalized.includes("wav")) {
      return "wav";
    }
    if (normalized.includes("quicktime")) {
      return "mov";
    }
    return fallback;
  }

  function inferContainerFamily(mime) {
    const normalized = String(mime || "").toLowerCase();
    if (!normalized) {
      return "unknown";
    }
    if (
      normalized.includes("webm") ||
      normalized.includes("vp8") ||
      normalized.includes("vp9") ||
      normalized.includes("vorbis") ||
      normalized.includes("opus")
    ) {
      return "webm";
    }
    if (normalized.includes("matroska")) {
      return "mkv";
    }
    if (normalized.includes("mp2t")) {
      return "ts";
    }
    if (
      normalized.includes("mp4") ||
      normalized.includes("avc1") ||
      normalized.includes("hvc1") ||
      normalized.includes("hev1") ||
      normalized.includes("mp4a") ||
      normalized.includes("aac")
    ) {
      return "mp4";
    }
    return "unknown";
  }

  function buildMuxPlan(videoMime, audioMime) {
    const videoFamily = inferContainerFamily(videoMime);
    const audioFamily = inferContainerFamily(audioMime);

    let outputExt = "mp4";
    let outputMime = "video/mp4";
    if (videoFamily === "webm" && (audioFamily === "webm" || !audioMime)) {
      outputExt = "webm";
      outputMime = "video/webm";
    } else if (
      videoFamily === "webm" ||
      audioFamily === "webm" ||
      videoFamily === "mkv" ||
      audioFamily === "mkv"
    ) {
      outputExt = "mkv";
      outputMime = "video/x-matroska";
    }

    const outputArgs =
      outputExt === "mp4"
        ? [
            "-avoid_negative_ts",
            "make_zero",
            "-start_at_zero",
            "-movflags",
            "+faststart",
          ]
        : [];

    return {
      inputAudioExt: getMimeExtension(
        audioMime,
        audioFamily === "webm" ? "webm" : "m4a",
      ),
      inputVideoExt: getMimeExtension(
        videoMime,
        videoFamily === "webm" ? "webm" : "mp4",
      ),
      outputArgs,
      outputExt,
      outputMime,
      outputName: `o.${outputExt}`,
    };
  }

  function createMediaBlob(chunks, mime, fallbackMime) {
    return new Blob(chunks || [], { type: mime || fallbackMime });
  }

  function buildMediaFilename(baseName, mime, fallbackExt = "bin") {
    return `${sanitizeFilenameSegment(baseName)}.${getMimeExtension(mime, fallbackExt)}`;
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.setAttribute("download", filename); // Safari needs setAttribute explicitly
    a.style.display = "none";
    document.body.appendChild(a);
    // Safari sometimes needs a tick for the blob URL to register
    setTimeout(() => {
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, BLOB_URL_REVOKE_DELAY_MS);
    }, 100);
  }

  function withTimeout(promise, ms, label = "Operation") {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
          ms,
        ),
      ),
    ]);
  }

  function formatBytes(b) {
    if (!Number.isFinite(b) || b <= 0) {
      return "0 B";
    }
    if (b < 1024) {
      return b + " B";
    }
    if (b < 1048576) {
      return (b / 1024).toFixed(0) + " KB";
    }
    if (b < 1073741824) {
      return (b / 1048576).toFixed(1) + " MB";
    }
    if (b < 1099511627776) {
      return (b / 1073741824).toFixed(2) + " GB";
    }
    return (b / 1099511627776).toFixed(2) + " TB";
  }

  function formatExactByteCount(bytes) {
    const safeBytes = Math.max(0, Math.floor(bytes || 0));
    try {
      return new Intl.NumberFormat().format(safeBytes);
    } catch {
      return String(safeBytes);
    }
  }

  function formatExactBytes(bytes) {
    return `${formatExactByteCount(bytes)} B`;
  }

  function toUrl(rawUrl, base = window.location.href) {
    if (typeof rawUrl !== "string") {
      return null;
    }
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return new URL(trimmed, base);
    } catch {
      return null;
    }
  }

  function toHttpUrl(rawUrl, base = window.location.href) {
    const parsed = toUrl(rawUrl, base);
    if (!parsed) {
      return null;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed;
    }
    return null;
  }

  function isBlobUrl(rawUrl) {
    return typeof rawUrl === "string" && rawUrl.startsWith("blob:");
  }

  function ensureHttpUrl(rawUrl, label) {
    const safe = toHttpUrl(rawUrl);
    if (!safe) {
      throw new Error(`${label}: blocked unsafe or invalid URL`);
    }
    return safe.href;
  }

  function normalizeRouteSource(src) {
    if (typeof src !== "string") {
      return null;
    }
    const trimmed = src.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("reddit:") || isBlobUrl(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("sniff:")) {
      const safe = toHttpUrl(trimmed.slice("sniff:".length));
      return safe ? `sniff:${safe.href}` : null;
    }
    const safe = toHttpUrl(trimmed);
    return safe ? safe.href : null;
  }

  function buildSniffRoute(url) {
    const safe = toHttpUrl(url);
    return safe ? `sniff:${safe.href}` : null;
  }

  function parseSniffRoute(route) {
    if (typeof route !== "string" || !route.startsWith("sniff:")) {
      return null;
    }
    const safe = toHttpUrl(route.slice("sniff:".length));
    return safe ? safe.href : null;
  }

  function isDashManifestUrl(url) {
    const safe = toHttpUrl(url);
    if (!safe) {
      return false;
    }
    const target = (safe.pathname + safe.search).toLowerCase();
    return target.includes(".mpd");
  }

  function isHlsManifestUrl(url) {
    const safe = toHttpUrl(url);
    if (!safe) {
      return false;
    }
    const target = (safe.pathname + safe.search).toLowerCase();
    return target.includes(".m3u8");
  }

  function pickPreferredManifestUrl(urls) {
    const candidates = [...new Set(urls)].filter(
      (url) => isHlsManifestUrl(url) || isDashManifestUrl(url),
    );
    candidates.sort((left, right) => {
      const leftSafe = toHttpUrl(left);
      const rightSafe = toHttpUrl(right);
      const leftMeta = sniffedManifestMeta.get(leftSafe?.href || left) || {};
      const rightMeta = sniffedManifestMeta.get(rightSafe?.href || right) || {};

      const leftScore = [
        leftSafe?.host === HOST ? 1 : 0,
        isHlsManifestUrl(left) ? 1 : 0,
        leftMeta.lastSeenAt || 0,
      ];
      const rightScore = [
        rightSafe?.host === HOST ? 1 : 0,
        isHlsManifestUrl(right) ? 1 : 0,
        rightMeta.lastSeenAt || 0,
      ];

      for (let i = 0; i < leftScore.length; i++) {
        if (leftScore[i] !== rightScore[i]) {
          return rightScore[i] - leftScore[i];
        }
      }
      return 0;
    });
    return candidates[0] || null;
  }

  function pushUniqueCapped(list, value, limit) {
    if (!value || list.includes(value)) {
      return;
    }
    list.push(value);
    if (list.length > limit) {
      list.splice(0, list.length - limit);
    }
  }

  function openInNewTab(url) {
    const safe = toHttpUrl(url);
    if (!safe) {
      Log.warn("Blocked unsafe new-tab URL:", url);
      return;
    }
    window.open(safe.href, "_blank", "noopener,noreferrer");
  }

  function navigateDetachedTab(tab, url) {
    const safe = toHttpUrl(url);
    if (!safe) {
      if (tab) {
        try {
          tab.close();
        } catch {
          // Ignore tab close failures.
        }
      }
      Log.warn("Blocked unsafe detached-tab URL:", url);
      return false;
    }

    if (!tab) {
      openInNewTab(safe.href);
      return true;
    }

    try {
      tab.opener = null;
    } catch {
      // Ignore opener assignment failures.
    }

    try {
      const payload = JSON.stringify(safe.href);
      tab.document.open();
      tab.document.write(
        `<!doctype html><meta http-equiv="referrer" content="no-referrer"><title>Redirecting</title><script>window.opener=null;location.replace(${payload});</script>`,
      );
      tab.document.close();
      return true;
    } catch (e) {
      Log.debug("Detached tab bootstrap failed:", e.message);
      try {
        tab.location.replace(safe.href);
        return true;
      } catch {
        try {
          tab.close();
        } catch {
          // Ignore tab close failures.
        }
      }
    }

    openInNewTab(safe.href);
    return true;
  }

  // Parallel downloader with concurrency limit and abort awareness
  async function downloadParallel(urls, concurrency, onEachDone) {
    const results = new Array(urls.length);
    let nextIdx = 0,
      completed = 0,
      firstError = null;

    async function worker() {
      while (nextIdx < urls.length && !firstError && currentDownloadId !== 0) {
        const idx = nextIdx++;
        try {
          results[idx] = await fetchBlob(urls[idx]);
          completed++;
          if (onEachDone) {
            onEachDone(completed, urls.length);
          }
        } catch (e) {
          if (!firstError) {
            firstError = e;
          }
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    if (firstError) {
      throw firstError;
    }
    return results;
  }

  // =========================================================================
  // SECTION 3: MSE INTERCEPTOR + NETWORK SNIFFER (page-context injection)
  // =========================================================================

  function injectPageScript() {
    const code = `(function () {
            if (window.__omnifetchInjected) {
                return;
            }
            window.__omnifetchInjected = true;

            var OF = window.__omnifetch = window.__omnifetch || {};
            var mediaSourceIds = new WeakMap();
            var spoolWorker = null;
            var spoolReady = false;
            var spoolInitPromise = null;
            var spoolRequestCounter = 0;
            var spoolPendingRequests = {};
            var spoolWorkerSource = ${JSON.stringify(MSE_SPOOL_WORKER_SOURCE)};

            OF.sessions = OF.sessions || {};
            OF.sessionOrder = Array.isArray(OF.sessionOrder) ? OF.sessionOrder : [];
            OF.blobUrlToSessionId = OF.blobUrlToSessionId || {};
            OF.activeSessionId = OF.activeSessionId || '';
            OF.lastPlayingSrc = OF.lastPlayingSrc || '';
            OF.videoChunks = Array.isArray(OF.videoChunks) ? OF.videoChunks : [];
            OF.audioChunks = Array.isArray(OF.audioChunks) ? OF.audioChunks : [];
            OF.videoChunkCount = OF.videoChunkCount || 0;
            OF.audioChunkCount = OF.audioChunkCount || 0;
            OF.videoMime = OF.videoMime || '';
            OF.audioMime = OF.audioMime || '';
            OF.videoStorageMode = OF.videoStorageMode || 'memory';
            OF.audioStorageMode = OF.audioStorageMode || 'memory';
            OF.captureLimitReached = Boolean(OF.captureLimitReached);
            OF.captureStopReason = OF.captureStopReason || '';
            OF.mseComplete = Boolean(OF.mseComplete);
            OF.sniffedUrls = Array.isArray(OF.sniffedUrls) ? OF.sniffedUrls : [];
            OF.totalVideoBytes = OF.totalVideoBytes || 0;
            OF.totalAudioBytes = OF.totalAudioBytes || 0;
            OF.totalCapturedBytes = OF.totalCapturedBytes || 0;
            OF.sessionCounter = OF.sessionCounter || 0;
            OF.maxBytes = ${settings.maxMSEMemoryMB * 1024 * 1024};
            OF.maxPendingSpoolBytes = ${MAX_MSE_SPOOL_PENDING_BYTES};
            OF.maxSessions = 12;
            OF.maxSessionAgeMs = 120000;
            OF.captureEnabled = ${settings.enableMSECapture};
            OF.sniffEnabled = ${settings.enableNetworkSniff};
            OF.autoDownload = ${settings.autoDownloadMSE ? 1 : 0};
            OF.legacyTrackDumpRequested = false;
            OF.maxSniffedUrls = ${settings.maxSniffedUrls};
            OF.quickPlay = 1.0;
            OF.diskCaptureAvailable = Boolean(OF.diskCaptureAvailable);
            OF.spoolStatus = OF.spoolStatus || 'memory';

            function defineReadonlyCompatFlag(name, getter) {
                try {
                    Object.defineProperty(window, name, {
                        get: getter,
                        set: function () {},
                        configurable: false
                    });
                } catch (e) {
                    try {
                        window[name] = getter();
                    } catch (innerError) {}
                }
            }

            defineReadonlyCompatFlag('autoDownload', function () { return OF.autoDownload; });
            defineReadonlyCompatFlag('downloadAll', function () { return OF.legacyTrackDumpRequested ? 1 : 0; });
            defineReadonlyCompatFlag('quickPlay', function () { return OF.quickPlay; });

            function normalizeUrl(raw) {
                if (typeof raw !== 'string' || !raw.trim()) {
                    return '';
                }
                try {
                    return new URL(raw, window.location.href).href;
                } catch (e) {
                    return '';
                }
            }

            function mirrorToString(wrapperFn, originalFn) {
                try {
                    Object.defineProperty(wrapperFn, 'toString', {
                        value: function () { return originalFn.toString(); },
                        configurable: true
                    });
                } catch (e) {}
            }

            function getTrackDescriptor(kind) {
                return kind === 'video'
                    ? {
                        bytes: 'totalVideoBytes',
                        chunks: 'videoChunks',
                        count: 'videoChunkCount',
                        mime: 'videoMime',
                        mode: 'videoStorageMode',
                        pending: 'videoPendingBytes',
                        token: 'videoTrackToken'
                    }
                    : {
                        bytes: 'totalAudioBytes',
                        chunks: 'audioChunks',
                        count: 'audioChunkCount',
                        mime: 'audioMime',
                        mode: 'audioStorageMode',
                        pending: 'audioPendingBytes',
                        token: 'audioTrackToken'
                    };
            }

            function getTrackBytes(session, kind) {
                return session[getTrackDescriptor(kind).bytes] || 0;
            }

            function getTrackChunkCount(session, kind) {
                return session[getTrackDescriptor(kind).count] || 0;
            }

            function getTrackMode(session, kind) {
                return session[getTrackDescriptor(kind).mode] || 'memory';
            }

            function hasSessionTrackData(session, kind) {
                return getTrackBytes(session, kind) > 0 || getTrackChunkCount(session, kind) > 0;
            }

            function hasSessionPayload(session) {
                return hasSessionTrackData(session, 'video') || hasSessionTrackData(session, 'audio');
            }

            function releaseCapturedBytes(amount) {
                OF.totalCapturedBytes = Math.max(0, (OF.totalCapturedBytes || 0) - Math.max(0, amount || 0));
            }

            function releaseTrackMemory(session, kind) {
                if (getTrackMode(session, kind) === 'memory') {
                    releaseCapturedBytes(getTrackBytes(session, kind));
                }
            }

            function markCaptureIssue(session, reason) {
                session.captureLimitReached = true;
                session.captureStopReason = reason || session.captureStopReason || 'capture-stopped';
                session.updatedAt = Date.now();
                if (!OF.activeSessionId || OF.activeSessionId === session.id || session.objectUrl === OF.lastPlayingSrc) {
                    syncLegacySession(session);
                }
            }

            function createSession(id) {
                return {
                    captureLimitReached: false,
                    captureStopReason: '',
                    id: id,
                    audioChunks: [],
                    audioChunkCount: 0,
                    audioMime: '',
                    audioPendingBytes: 0,
                    audioStorageMode: 'memory',
                    audioTrackToken: 0,
                    createdAt: Date.now(),
                    mseComplete: false,
                    objectUrl: '',
                    totalAudioBytes: 0,
                    totalVideoBytes: 0,
                    updatedAt: Date.now(),
                    videoChunks: [],
                    videoChunkCount: 0,
                    videoPendingBytes: 0,
                    videoMime: '',
                    videoStorageMode: 'memory',
                    videoTrackToken: 0
                };
            }

            function callSpoolWorker(type, payload, transferList) {
                if (!spoolWorker) {
                    return Promise.reject(new Error('OPFS spool worker unavailable'));
                }
                spoolRequestCounter += 1;
                var requestId = 'spool_' + spoolRequestCounter;
                return new Promise(function (resolve, reject) {
                    spoolPendingRequests[requestId] = { resolve: resolve, reject: reject };
                    try {
                        spoolWorker.postMessage({
                            id: requestId,
                            payload: payload || {},
                            type: type
                        }, transferList || []);
                    } catch (error) {
                        delete spoolPendingRequests[requestId];
                        reject(error);
                    }
                });
            }

            function initSpoolWorker() {
                if (spoolInitPromise) {
                    return spoolInitPromise;
                }
                if (!window.Worker || !window.Blob || !window.URL || typeof window.URL.createObjectURL !== 'function') {
                    OF.diskCaptureAvailable = false;
                    OF.spoolStatus = 'unsupported';
                    spoolInitPromise = Promise.resolve(false);
                    return spoolInitPromise;
                }

                try {
                    var workerBlob = new window.Blob([spoolWorkerSource], { type: 'text/javascript' });
                    var workerUrl = window.URL.createObjectURL(workerBlob);
                    spoolWorker = new window.Worker(workerUrl);
                    window.URL.revokeObjectURL(workerUrl);
                } catch (e) {
                    OF.diskCaptureAvailable = false;
                    OF.spoolStatus = 'error';
                    spoolInitPromise = Promise.resolve(false);
                    return spoolInitPromise;
                }

                spoolWorker.onmessage = function (event) {
                    var data = event.data || {};
                    var pending = spoolPendingRequests[data.id];
                    if (!pending) {
                        return;
                    }
                    delete spoolPendingRequests[data.id];
                    if (data.ok) {
                        pending.resolve(data.result);
                    } else {
                        pending.reject(new Error(data.error || 'Spool worker request failed'));
                    }
                };

                spoolWorker.onerror = function () {
                    spoolReady = false;
                    OF.diskCaptureAvailable = false;
                    OF.spoolStatus = 'error';
                };

                spoolInitPromise = callSpoolWorker('ping', {})
                    .then(function () {
                        spoolReady = true;
                        OF.diskCaptureAvailable = true;
                        OF.spoolStatus = 'opfs';
                        return true;
                    })
                    .catch(function () {
                        spoolReady = false;
                        OF.diskCaptureAvailable = false;
                        OF.spoolStatus = 'memory';
                        return false;
                    });

                return spoolInitPromise;
            }

            function releaseSessionSpool(sessionId) {
                if (!spoolWorker) {
                    return;
                }
                callSpoolWorker('releaseSession', { sessionId: sessionId }).catch(function () {});
            }

            function queueTrackSpoolWrite(session, kind, buffer) {
                if (!spoolReady || session.captureLimitReached) {
                    return false;
                }
                var descriptor = getTrackDescriptor(kind);
                var byteLength = buffer.byteLength || 0;
                var nextPending = (session[descriptor.pending] || 0) + byteLength;
                if (nextPending > OF.maxPendingSpoolBytes) {
                    markCaptureIssue(session, 'spool-backpressure');
                    return false;
                }

                session[descriptor.pending] = nextPending;
                var expectedToken = session[descriptor.token] || 0;
                callSpoolWorker('appendTrack', {
                    buffer: buffer,
                    kind: kind,
                    sessionId: session.id
                }, [buffer]).then(function () {
                    var activeSession = OF.sessions[session.id];
                    if (!activeSession) {
                        return;
                    }
                    var activeDescriptor = getTrackDescriptor(kind);
                    activeSession[activeDescriptor.pending] = Math.max(0, (activeSession[activeDescriptor.pending] || 0) - byteLength);
                }).catch(function () {
                    var activeSession = OF.sessions[session.id];
                    if (!activeSession) {
                        return;
                    }
                    var activeDescriptor = getTrackDescriptor(kind);
                    activeSession[activeDescriptor.pending] = Math.max(0, (activeSession[activeDescriptor.pending] || 0) - byteLength);
                    if ((activeSession[activeDescriptor.token] || 0) !== expectedToken) {
                        return;
                    }
                    activeSession[activeDescriptor.bytes] = Math.max(0, (activeSession[activeDescriptor.bytes] || 0) - byteLength);
                    activeSession[activeDescriptor.count] = Math.max(0, (activeSession[activeDescriptor.count] || 0) - 1);
                    markCaptureIssue(activeSession, 'spool-error');
                });
                return true;
            }

            function dropSession(id) {
                var session = OF.sessions[id];
                if (!session) {
                    return;
                }
                releaseTrackMemory(session, 'video');
                releaseTrackMemory(session, 'audio');
                releaseSessionSpool(id);
                if (session.objectUrl) {
                    delete OF.blobUrlToSessionId[session.objectUrl];
                }
                delete OF.sessions[id];
                OF.sessionOrder = OF.sessionOrder.filter(function (entry) { return entry !== id; });
                if (OF.activeSessionId === id) {
                    OF.activeSessionId = '';
                }
            }

            function pruneSessions() {
                var now = Date.now();
                OF.sessionOrder.slice().forEach(function (id) {
                    var session = OF.sessions[id];
                    if (!session || OF.activeSessionId === id) {
                        return;
                    }
                    if ((now - (session.updatedAt || session.createdAt || now)) > OF.maxSessionAgeMs) {
                        dropSession(id);
                    }
                });
                while (OF.sessionOrder.length > OF.maxSessions) {
                    var victimId = OF.sessionOrder.find(function (entry) { return entry !== OF.activeSessionId; }) || OF.sessionOrder[0];
                    if (!victimId) {
                        break;
                    }
                    dropSession(victimId);
                }
            }

            function getSession(id) {
                if (!OF.sessions[id]) {
                    OF.sessions[id] = createSession(id);
                    OF.sessionOrder.push(id);
                    pruneSessions();
                }
                return OF.sessions[id];
            }

            function ensureSessionForMediaSource(mediaSource) {
                var id = mediaSourceIds.get(mediaSource);
                if (!id) {
                    OF.sessionCounter += 1;
                    id = 'mse_' + OF.sessionCounter;
                    mediaSourceIds.set(mediaSource, id);
                }
                return getSession(id);
            }

            function isKnownMediaSourceObject(obj) {
                return Boolean(
                    obj && (
                        mediaSourceIds.has(obj) ||
                        (window.MediaSource && obj instanceof window.MediaSource) ||
                        (window.ManagedMediaSource && obj instanceof window.ManagedMediaSource) ||
                        (window.WebKitMediaSource && obj instanceof window.WebKitMediaSource)
                    )
                );
            }

            function compareSessions(left, right) {
                var leftScore = [
                    left && left.objectUrl && left.objectUrl === OF.lastPlayingSrc ? 1 : 0,
                    left && left.mseComplete ? 1 : 0,
                    left && hasSessionTrackData(left, 'video') ? 1 : 0,
                    left && left.updatedAt ? left.updatedAt : 0,
                    left ? (left.totalVideoBytes || 0) + (left.totalAudioBytes || 0) : 0
                ];
                var rightScore = [
                    right && right.objectUrl && right.objectUrl === OF.lastPlayingSrc ? 1 : 0,
                    right && right.mseComplete ? 1 : 0,
                    right && hasSessionTrackData(right, 'video') ? 1 : 0,
                    right && right.updatedAt ? right.updatedAt : 0,
                    right ? (right.totalVideoBytes || 0) + (right.totalAudioBytes || 0) : 0
                ];
                for (var i = 0; i < leftScore.length; i += 1) {
                    if (leftScore[i] !== rightScore[i]) {
                        return leftScore[i] > rightScore[i] ? 1 : -1;
                    }
                }
                return 0;
            }

            function getBestSession() {
                var best = null;
                OF.sessionOrder.forEach(function (id) {
                    var candidate = OF.sessions[id];
                    if (!candidate) {
                        return;
                    }
                    if (!hasSessionPayload(candidate)) {
                        return;
                    }
                    if (!best || compareSessions(candidate, best) > 0) {
                        best = candidate;
                    }
                });
                return best;
            }

            function syncLegacySession(session) {
                var activeSession = OF.activeSessionId && OF.sessions[OF.activeSessionId];
                var hasActivePayload = activeSession && hasSessionPayload(activeSession);
                var nextSession = session || (hasActivePayload ? activeSession : null) || getBestSession();
                if (!nextSession) {
                    OF.activeSessionId = '';
                    OF.videoChunks = [];
                    OF.audioChunks = [];
                    OF.videoChunkCount = 0;
                    OF.audioChunkCount = 0;
                    OF.videoMime = '';
                    OF.audioMime = '';
                    OF.videoStorageMode = OF.diskCaptureAvailable ? 'opfs' : 'memory';
                    OF.audioStorageMode = OF.diskCaptureAvailable ? 'opfs' : 'memory';
                    OF.captureLimitReached = false;
                    OF.captureStopReason = '';
                    OF.totalVideoBytes = 0;
                    OF.totalAudioBytes = 0;
                    OF.mseComplete = false;
                } else {
                    OF.activeSessionId = nextSession.id;
                    OF.videoChunks = nextSession.videoChunks;
                    OF.audioChunks = nextSession.audioChunks;
                    OF.videoChunkCount = nextSession.videoChunkCount || 0;
                    OF.audioChunkCount = nextSession.audioChunkCount || 0;
                    OF.videoMime = nextSession.videoMime;
                    OF.audioMime = nextSession.audioMime;
                    OF.videoStorageMode = nextSession.videoStorageMode || 'memory';
                    OF.audioStorageMode = nextSession.audioStorageMode || 'memory';
                    OF.captureLimitReached = Boolean(nextSession.captureLimitReached);
                    OF.captureStopReason = nextSession.captureStopReason || '';
                    OF.totalVideoBytes = nextSession.totalVideoBytes;
                    OF.totalAudioBytes = nextSession.totalAudioBytes;
                    OF.mseComplete = Boolean(nextSession.mseComplete);
                }
                window.video = OF.videoChunks;
                window.audio = OF.audioChunks;
                window.isComplete = OF.mseComplete ? 1 : 0;
                return nextSession || null;
            }

            function resolveSessionBySource(sourceUrl) {
                var normalized = normalizeUrl(sourceUrl);
                if (normalized) {
                    OF.lastPlayingSrc = normalized;
                    var sessionId = OF.blobUrlToSessionId[normalized];
                    if (sessionId && OF.sessions[sessionId]) {
                        return OF.sessions[sessionId];
                    }
                }
                return getBestSession();
            }

            OF.selectSessionBySource = function (sourceUrl) {
                return syncLegacySession(resolveSessionBySource(sourceUrl));
            };
            OF.syncActiveSession = function () {
                return syncLegacySession(resolveSessionBySource(OF.lastPlayingSrc));
            };
            OF.getTrackBlobBySource = async function (sourceUrl, kind) {
                var session = resolveSessionBySource(sourceUrl || OF.lastPlayingSrc);
                if (!session) {
                    return null;
                }
                var descriptor = getTrackDescriptor(kind);
                var mime = session[descriptor.mime] || (kind === 'video' ? 'video/mp4' : 'audio/mp4');
                if (session[descriptor.mode] === 'opfs' && session[descriptor.bytes] > 0 && spoolReady) {
                    var snapshot = await callSpoolWorker('snapshotTrack', {
                        kind: kind,
                        sessionId: session.id
                    });
                    if (snapshot && snapshot.file) {
                        return snapshot.file.type ? snapshot.file : snapshot.file.slice(0, snapshot.file.size, mime);
                    }
                }
                return new Blob(session[descriptor.chunks] || [], { type: mime });
            };
            OF.releaseSessionBySource = function (sourceUrl) {
                var session = resolveSessionBySource(sourceUrl);
                if (!session) {
                    return false;
                }
                var releasedId = session.id;
                dropSession(releasedId);
                syncLegacySession(resolveSessionBySource(''));
                return releasedId;
            };
            OF.resetCaptureState = function () {
                Object.keys(OF.sessions).forEach(dropSession);
                OF.sessions = {};
                OF.sessionOrder = [];
                OF.blobUrlToSessionId = {};
                OF.activeSessionId = '';
                OF.lastPlayingSrc = '';
                OF.sniffedUrls = [];
                OF.captureLimitReached = false;
                OF.totalCapturedBytes = 0;
                OF.legacyTrackDumpRequested = false;
                syncLegacySession(null);
                window.isComplete = 0;
            };

            function resetTrack(session, kind, mimeStr) {
                var descriptor = getTrackDescriptor(kind);
                releaseTrackMemory(session, kind);
                session[descriptor.chunks] = [];
                session[descriptor.mime] = mimeStr;
                session[descriptor.bytes] = 0;
                session[descriptor.count] = 0;
                session[descriptor.pending] = 0;
                session[descriptor.token] = (session[descriptor.token] || 0) + 1;
                session[descriptor.mode] = spoolReady ? 'opfs' : 'memory';
                session.captureLimitReached = false;
                session.captureStopReason = '';
                session.mseComplete = false;
                session.updatedAt = Date.now();
                if (spoolReady) {
                    callSpoolWorker('resetTrack', {
                        kind: kind,
                        sessionId: session.id
                    }).catch(function () {
                        session[descriptor.mode] = 'memory';
                        session.updatedAt = Date.now();
                        if (!OF.activeSessionId || OF.activeSessionId === session.id) {
                            syncLegacySession(session);
                        }
                    });
                }
                if (!OF.activeSessionId || OF.activeSessionId === session.id) {
                    syncLegacySession(session);
                } else {
                    syncLegacySession(null);
                }
            }

            function captureTrackBytes(session, kind, bytes) {
                if (!bytes || !bytes.byteLength || session.captureLimitReached) {
                    return;
                }

                var descriptor = getTrackDescriptor(kind);
                if (
                    session[descriptor.mode] !== 'opfs' &&
                    spoolReady &&
                    (session[descriptor.bytes] || 0) === 0 &&
                    (session[descriptor.count] || 0) === 0
                ) {
                    session[descriptor.mode] = 'opfs';
                }
                if (session[descriptor.mode] === 'opfs' && spoolReady) {
                    var diskCopy = new Uint8Array(bytes.byteLength);
                    diskCopy.set(bytes);
                    if (queueTrackSpoolWrite(session, kind, diskCopy.buffer)) {
                        session[descriptor.bytes] += bytes.byteLength;
                        session[descriptor.count] += 1;
                        session.updatedAt = Date.now();
                        if (!OF.activeSessionId || OF.activeSessionId === session.id || session.objectUrl === OF.lastPlayingSrc) {
                            syncLegacySession(session);
                        }
                    }
                    return;
                }

                var totalNow = (OF.totalCapturedBytes || 0) + bytes.byteLength;
                if (totalNow > OF.maxBytes) {
                    markCaptureIssue(session, 'memory-cap');
                    return;
                }

                var copy = new Uint8Array(bytes.byteLength);
                copy.set(bytes);
                session[descriptor.chunks].push(copy.buffer);
                session[descriptor.bytes] += bytes.byteLength;
                session[descriptor.count] += 1;
                OF.totalCapturedBytes = totalNow;
                session.updatedAt = Date.now();
                if (!OF.activeSessionId || OF.activeSessionId === session.id || session.objectUrl === OF.lastPlayingSrc) {
                    syncLegacySession(session);
                }
            }

            if (OF.captureEnabled) {
                initSpoolWorker();
            }

            if (window.URL && typeof window.URL.createObjectURL === 'function' && !window.__omnifetchCreateObjectUrlHooked) {
                window.__omnifetchCreateObjectUrlHooked = true;
                var _createObjectURL = window.URL.createObjectURL;
                window.URL.createObjectURL = function (obj) {
                    var objectUrl = _createObjectURL.apply(this, arguments);
                    try {
                        var session = isKnownMediaSourceObject(obj) ? ensureSessionForMediaSource(obj) : null;
                        if (session) {
                            if (session.objectUrl && session.objectUrl !== objectUrl) {
                                delete OF.blobUrlToSessionId[session.objectUrl];
                            }
                            session.objectUrl = objectUrl;
                            session.updatedAt = Date.now();
                            OF.blobUrlToSessionId[objectUrl] = session.id;
                            if (!OF.activeSessionId || OF.lastPlayingSrc === objectUrl || OF.activeSessionId === session.id) {
                                syncLegacySession(session);
                            }
                        }
                    } catch (e) {}
                    return objectUrl;
                };
                mirrorToString(window.URL.createObjectURL, _createObjectURL);
            }

            // Hooks both MediaSource (Chrome/Firefox/old Safari) and
            // ManagedMediaSource (Safari 17+) for full WebKit coverage.
            function hookMSEProto(MSE) {
                if (!MSE || !MSE.prototype || !MSE.prototype.addSourceBuffer) {
                    return;
                }
                try {
                    var _addSB = MSE.prototype.addSourceBuffer;
                    MSE.prototype.addSourceBuffer = function (mime) {
                        var session = ensureSessionForMediaSource(this);
                        var mimeStr = String(mime || '');
                        var isVideo = mimeStr.includes('video');
                        var isAudio = mimeStr.includes('audio');

                        if (isVideo) {
                            resetTrack(session, 'video', mimeStr);
                        }
                        if (isAudio) {
                            resetTrack(session, 'audio', mimeStr);
                        }

                        window.isComplete = 0;

                        var sourceBuffer = _addSB.call(this, mime);
                        if (sourceBuffer && sourceBuffer.appendBuffer) {
                            var _append = sourceBuffer.appendBuffer;
                            sourceBuffer.appendBuffer = function (buffer) {
                                try {
                                    var bytes;
                                    if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
                                    else if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                                    else bytes = new Uint8Array(buffer);

                                    if (isVideo) {
                                        captureTrackBytes(session, 'video', bytes);
                                    }
                                    if (isAudio) {
                                        captureTrackBytes(session, 'audio', bytes);
                                    }
                                } catch (e) {}
                                return _append.call(this, buffer);
                            };
                            mirrorToString(sourceBuffer.appendBuffer, _append);
                        }
                        return sourceBuffer;
                    };
                    mirrorToString(MSE.prototype.addSourceBuffer, _addSB);

                    var _endOfStream = MSE.prototype.endOfStream;
                    MSE.prototype.endOfStream = function () {
                        var session = ensureSessionForMediaSource(this);
                        session.mseComplete = true;
                        session.updatedAt = Date.now();
                        syncLegacySession(session.objectUrl === OF.lastPlayingSrc ? session : null);
                        try {
                            window.dispatchEvent(new CustomEvent('omnifetch-mse-complete', {
                                detail: { sessionId: session.id, sourceUrl: session.objectUrl || '' }
                            }));
                        } catch (e) {}
                        if (OF.autoDownload === 1) {
                            try {
                                window.dispatchEvent(new CustomEvent('omnifetch-auto-download-request', {
                                    detail: { sessionId: session.id, sourceUrl: session.objectUrl || '' }
                                }));
                            } catch (e) {}
                        }
                        return _endOfStream.apply(this, arguments);
                    };
                    mirrorToString(MSE.prototype.endOfStream, _endOfStream);
                } catch (e) {}
            }

            if (OF.captureEnabled) {
                hookMSEProto(window.MediaSource);
                hookMSEProto(window.ManagedMediaSource);
                hookMSEProto(window.WebKitMediaSource);
            }

            if (!window.__omnifetchPlayingHooked) {
                window.__omnifetchPlayingHooked = true;
                document.addEventListener('playing', function (event) {
                    var media = event.target;
                    if (media && media.currentSrc) {
                        OF.selectSessionBySource(media.currentSrc);
                    }
                }, true);
            }

            if (OF.sniffEnabled) {
                var pushUrl = function (url) {
                    if (typeof url !== 'string') {
                        return;
                    }
                    try {
                        var resolved = new URL(url, window.location.href);
                        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
                            return;
                        }
                        var target = (resolved.pathname + resolved.search).toLowerCase();
                        if (!target.includes('.m3u8') && !target.includes('.mpd')) {
                            return;
                        }
                        var normalized = resolved.href;
                        if (OF.sniffedUrls.indexOf(normalized) === -1) {
                            OF.sniffedUrls.push(normalized);
                            if (OF.sniffedUrls.length > OF.maxSniffedUrls) {
                                OF.sniffedUrls.shift();
                            }
                        }
                        try {
                            window.dispatchEvent(new CustomEvent('omnifetch-url-sniffed', {
                                detail: { url: normalized }
                            }));
                        } catch (e) {}
                    } catch (e) {}
                };

                if (window.fetch) {
                    var _fetch = window.fetch;
                    window.fetch = function (input) {
                        try {
                            var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                            pushUrl(url);
                        } catch (e) {}
                        return _fetch.apply(this, arguments);
                    };
                }

                if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
                    var _xhrOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function (method, url) {
                        try {
                            pushUrl(url);
                        } catch (e) {}
                        return _xhrOpen.apply(this, arguments);
                    };
                }
            }

            if (!window.__omnifetchHistoryHooked && window.history) {
                window.__omnifetchHistoryHooked = true;
                try {
                    var _push = history.pushState;
                    var _replace = history.replaceState;
                    if (_push) {
                        history.pushState = function () {
                            var result = _push.apply(this, arguments);
                            try {
                                window.dispatchEvent(new CustomEvent('omnifetch-navigation', {
                                    detail: { type: 'pushState', url: location.href }
                                }));
                            } catch (e) {}
                            return result;
                        };
                    }
                    if (_replace) {
                        history.replaceState = function () {
                            var result = _replace.apply(this, arguments);
                            try {
                                window.dispatchEvent(new CustomEvent('omnifetch-navigation', {
                                    detail: { type: 'replaceState', url: location.href }
                                }));
                            } catch (e) {}
                            return result;
                        };
                    }
                } catch (e) {}
            }

            OF.syncActiveSession();
        })();`;

    // CSP-safe injection: try script tag first, fall back to eval via unsafeWindow
    try {
      const s = document.createElement("script");
      s.textContent = code;
      (document.documentElement || document.head || document.body).appendChild(
        s,
      );
      s.remove();
    } catch {
      Log.warn("Script injection blocked (CSP?), trying unsafeWindow fallback");
      try {
        uWindow.eval(code);
      } catch (e2) {
        Log.error("Page injection failed entirely:", e2.message);
      }
    }
  }

  // Inject as early as possible
  injectPageScript();

  // =========================================================================
  // SECTION 4: FFmpeg.wasm MUXER (lazy-loaded)
  // =========================================================================

  const FFMPEG_ASSETS = {
    coreJs: {
      sha256:
        "a34873964b0f62aec516bac75e3aa9086ec3535d4d07f0269aa94ea748b6cb71",
      url: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
    },
    coreWasm: {
      sha256:
        "2390efa7fb66e7e42dbae15427571a5ffc96b829480904c30f471f0a78967f61",
      url: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
    },
    script: {
      sha256:
        "a70790ae45aa175fb1c347a1cc5f6e1c59058616a3ecafd9c17613cbc7fd06e3",
      url: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.min.js",
    },
  };

  let ffmpegInstance = null;
  let ffmpegLoading = false;
  let ffmpegReady = false;
  const ffmpegAssetObjectUrls = [];

  async function fetchArrayBuffer(url, timeoutMs, label) {
    const safeUrl = ensureHttpUrl(url, label);
    const response = await gmRequest({
      method: "GET",
      url: safeUrl,
      responseType: "arraybuffer",
      headers: { Accept: "*/*", Referer: window.location.href },
      timeout: timeoutMs,
    });
    const data = response.response;
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );
    }
    if (data instanceof Blob) {
      return data.arrayBuffer();
    }
    if (
      data &&
      typeof data === "object" &&
      typeof data.arrayBuffer === "function"
    ) {
      return data.arrayBuffer();
    }
    if (typeof response.responseText === "string") {
      return new TextEncoder().encode(response.responseText).buffer;
    }
    throw new Error(`${label}: unsupported binary response`);
  }

  async function sha256Hex(arrayBuffer) {
    if (!window.crypto?.subtle) {
      throw new Error("Web Crypto unavailable for integrity verification");
    }
    const digest = await window.crypto.subtle.digest("SHA-256", arrayBuffer);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  async function createVerifiedBlobUrl(asset, mimeType, label) {
    const bytes = await fetchArrayBuffer(
      asset.url,
      settings.requestTimeoutBlob,
      label,
    );
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== asset.sha256) {
      throw new Error(`${label}: integrity check failed`);
    }
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    ffmpegAssetObjectUrls.push(blobUrl);
    return blobUrl;
  }

  async function loadVerifiedScriptAsset(asset, label) {
    const bytes = await fetchArrayBuffer(
      asset.url,
      settings.requestTimeoutBlob,
      label,
    );
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== asset.sha256) {
      throw new Error(`${label}: integrity check failed`);
    }

    const scriptText = new TextDecoder("utf-8").decode(bytes);
    const blobUrl = URL.createObjectURL(
      new Blob([scriptText], { type: "text/javascript" }),
    );
    ffmpegAssetObjectUrls.push(blobUrl);

    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = blobUrl;
          script.onload = () => {
            script.remove();
            resolve();
          };
          script.onerror = () => {
            script.remove();
            reject(new Error(`${label}: script injection failed`));
          };
          (document.head || document.documentElement).appendChild(script);
        }),
        25000,
        label,
      );
    } catch {
      Log.warn(`${label}: blob injection failed, using verified eval fallback`);
      uWindow.eval(scriptText);
    }
  }

  async function loadFFmpeg() {
    if (ffmpegReady) {
      return true;
    }
    if (ffmpegLoading) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (ffmpegReady || !ffmpegLoading) {
            clearInterval(check);
            resolve(ffmpegReady);
          }
        }, 300);
        setTimeout(() => {
          clearInterval(check);
          resolve(ffmpegReady);
        }, 40000);
      });
    }
    ffmpegLoading = true;
    try {
      // Detect Safari and cross-origin isolation status
      const isSafari = /^((?!chrome|android).)*safari/i.test(
        navigator.userAgent,
      );
      const hasSAB = typeof SharedArrayBuffer !== "undefined";
      Log.info(`FFmpeg env: Safari=${isSafari}, SharedArrayBuffer=${hasSAB}`);

      let lib = window.FFmpegWASM || window.FFmpeg;
      if (!lib) {
        Log.info("Loading FFmpeg.wasm from verified asset set...");
        await loadVerifiedScriptAsset(FFMPEG_ASSETS.script, "FFmpeg wrapper");
        lib = window.FFmpegWASM || window.FFmpeg;
      }
      if (lib?.FFmpeg) {
        ffmpegInstance = new lib.FFmpeg();
        // Always use the single-threaded UMD core — it works in Safari
        // and every other browser without needing COOP/COEP headers.
        const coreURL = await createVerifiedBlobUrl(
          FFMPEG_ASSETS.coreJs,
          "text/javascript",
          "FFmpeg core JS",
        );
        const wasmURL = await createVerifiedBlobUrl(
          FFMPEG_ASSETS.coreWasm,
          "application/wasm",
          "FFmpeg core WASM",
        );
        const loadOpts = {
          coreURL,
          wasmURL,
        };
        await withTimeout(
          ffmpegInstance.load(loadOpts),
          40000,
          "FFmpeg WASM load",
        );
        ffmpegReady = true;
        Log.info("FFmpeg.wasm ready (integrity-verified UMD core).");
      } else {
        throw new Error("FFmpeg constructor unavailable after script load");
      }
    } catch (e) {
      Log.error("FFmpeg load failed:", e.message);
      ffmpegReady = false;
    }
    ffmpegLoading = false;
    return ffmpegReady;
  }

  async function muxVideoAudio(videoBlob, audioBlob, muxPlan = null) {
    if (!(await loadFFmpeg()) || !ffmpegInstance) {
      return null;
    }
    const plan = muxPlan || buildMuxPlan(videoBlob.type, audioBlob.type);
    try {
      showProgressOverlay("Muxing audio + video...");
      const vData = new Uint8Array(await videoBlob.arrayBuffer());
      const aData = new Uint8Array(await audioBlob.arrayBuffer());
      const inputVideoName = `iv.${plan.inputVideoExt}`;
      const inputAudioName = `ia.${plan.inputAudioExt}`;
      await ffmpegInstance.writeFile(inputVideoName, vData);
      await ffmpegInstance.writeFile(inputAudioName, aData);
      await withTimeout(
        ffmpegInstance.exec([
          "-fflags",
          "+genpts+igndts",
          "-i",
          inputVideoName,
          "-fflags",
          "+genpts+igndts",
          "-i",
          inputAudioName,
          "-c:v",
          "copy",
          "-c:a",
          "copy",
          ...plan.outputArgs,
          plan.outputName,
        ]),
        90000,
        "FFmpeg mux",
      );
      const out = await ffmpegInstance.readFile(plan.outputName);
      const result = new Blob([out.buffer], { type: plan.outputMime });
      for (const f of [inputVideoName, inputAudioName, plan.outputName]) {
        try {
          await ffmpegInstance.deleteFile(f);
        } catch {
          // Cleanup failures are non-fatal.
        }
      }
      hideProgressOverlay();
      return result;
    } catch (e) {
      Log.error("Mux failed:", e.message);
      hideProgressOverlay();
      return null;
    }
  }

  async function remuxToMP4(inputBlob, inputExt = "ts") {
    if (!(await loadFFmpeg()) || !ffmpegInstance) {
      return null;
    }
    try {
      showProgressOverlay("Remuxing to MP4...");
      const data = new Uint8Array(await inputBlob.arrayBuffer());
      const inName = "in." + inputExt;
      await ffmpegInstance.writeFile(inName, data);
      await withTimeout(
        ffmpegInstance.exec([
          "-fflags",
          "+genpts+igndts",
          "-i",
          inName,
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-start_at_zero",
          "-movflags",
          "+faststart",
          "o.mp4",
        ]),
        90000,
        "FFmpeg remux",
      );
      const out = await ffmpegInstance.readFile("o.mp4");
      const result = new Blob([out.buffer], { type: "video/mp4" });
      for (const f of [inName, "o.mp4"]) {
        try {
          await ffmpegInstance.deleteFile(f);
        } catch {
          // Cleanup failures are non-fatal.
        }
      }
      hideProgressOverlay();
      return result;
    } catch (e) {
      Log.warn("Remux failed:", e.message);
      hideProgressOverlay();
      return null;
    }
  }

  // =========================================================================
  // SECTION 5: HLS PARSER + DOWNLOADER (real m3u8 support)
  // Handles: master playlists, fMP4 (EXT-X-MAP), byte ranges, audio renditions
  // Detects: EXT-X-KEY (encrypted) and refuses gracefully
  // =========================================================================

  function parseM3U8(text, baseUrl) {
    const lines = text.split("\n").map((l) => l.trim());
    const result = {
      isMaster: false,
      variants: [], // { bandwidth, resolution, url, audioGroupId }
      segments: [], // { url, duration, byteRange }
      initSegment: null, // { url, byteRange } — fMP4 EXT-X-MAP
      isEncrypted: false,
      isFMP4: false,
      audioRenditions: [], // { groupId, url, language, name }
      totalDuration: 0,
    };

    let currentDuration = 0;
    let currentByteRange = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Master playlist indicators
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        result.isMaster = true;
        const bw = line.match(/BANDWIDTH=(\d+)/);
        const res = line.match(/RESOLUTION=(\d+x\d+)/);
        const audio = line.match(/AUDIO="([^"]+)"/);
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith("#")) {
          result.variants.push({
            bandwidth: bw ? parseInt(bw[1], 10) : 0,
            resolution: res ? res[1] : "",
            url: new URL(nextLine, baseUrl).href,
            audioGroupId: audio ? audio[1] : null,
          });
        }
      }

      // Audio renditions
      if (line.startsWith("#EXT-X-MEDIA") && line.includes("TYPE=AUDIO")) {
        const uri = line.match(/URI="([^"]+)"/);
        const gid = line.match(/GROUP-ID="([^"]+)"/);
        const lang = line.match(/LANGUAGE="([^"]+)"/);
        const name = line.match(/NAME="([^"]+)"/);
        if (uri) {
          result.audioRenditions.push({
            groupId: gid ? gid[1] : "",
            url: new URL(uri[1], baseUrl).href,
            language: lang ? lang[1] : "",
            name: name ? name[1] : "",
          });
        }
      }

      // Encryption detection
      if (line.startsWith("#EXT-X-KEY") && !line.includes("METHOD=NONE")) {
        result.isEncrypted = true;
      }

      // fMP4 init segment
      if (line.startsWith("#EXT-X-MAP")) {
        result.isFMP4 = true;
        const uri = line.match(/URI="([^"]+)"/);
        const br = line.match(/BYTERANGE="([^"]+)"/);
        if (uri) {
          result.initSegment = {
            url: new URL(uri[1], baseUrl).href,
            byteRange: br ? br[1] : null,
          };
        }
      }

      // Segment duration
      if (line.startsWith("#EXTINF")) {
        const dur = parseFloat(line.split(":")[1]);
        if (!isNaN(dur)) {
          currentDuration = dur;
        }
      }

      // Byte range
      if (line.startsWith("#EXT-X-BYTERANGE")) {
        const parts = line.split(":")[1] || line.split("=")[1] || "";
        currentByteRange = parts.trim();
      }

      // Segment URL (non-comment, non-empty line after EXTINF)
      if (!line.startsWith("#") && line.length > 0 && !result.isMaster) {
        try {
          const segUrl = new URL(line, baseUrl).href;
          const seg = { url: segUrl, duration: currentDuration };
          if (currentByteRange) {
            seg.byteRange = currentByteRange;
            currentByteRange = null;
          }
          result.segments.push(seg);
          result.totalDuration += currentDuration;
          currentDuration = 0;
        } catch {
          /* skip malformed URLs */
        }
      }
    }

    return result;
  }

  async function getHLSPlaylistSpec(playlistUrl, trackType = "video") {
    const text = await fetchText(playlistUrl);
    const playlist = parseM3U8(text, playlistUrl);

    if (playlist.isEncrypted) {
      throw new Error("Encrypted HLS stream");
    }
    if (playlist.segments.length === 0) {
      throw new Error("No segments in playlist");
    }

    const urls = [];
    if (playlist.initSegment) {
      urls.push(playlist.initSegment.url);
    }
    playlist.segments.forEach((segment) => urls.push(segment.url));

    const mime = playlist.isFMP4
      ? trackType === "audio"
        ? "audio/mp4"
        : "video/mp4"
      : "video/mp2t";
    const ext = playlist.isFMP4
      ? trackType === "audio"
        ? "m4a"
        : "mp4"
      : "ts";

    return {
      estimatedBytes: await estimateSegmentedDownloadBytes(urls),
      ext,
      mime,
      playlist,
      totalDuration: playlist.totalDuration,
      trackType,
      urls,
    };
  }

  function ensureMuxFitsMemory(videoBytes, audioBytes, label) {
    const totalBytes = (videoBytes || 0) + (audioBytes || 0);
    if (totalBytes > MAX_FFMPEG_INPUT_BYTES) {
      throw new Error(
        `${label} is too large to mux safely in-browser (${formatBytes(totalBytes)}). OmniFetch will only mux smaller captures; use disk-streaming track downloads for large segmented media.`,
      );
    }
  }

  async function downloadHLS(m3u8Url, btn, dlId) {
    Log.info("HLS download:", m3u8Url);
    const masterText = await fetchText(m3u8Url);
    const master = parseM3U8(masterText, m3u8Url);

    if (master.isEncrypted) {
      throw new Error(
        "This HLS stream is encrypted (DRM). OmniFetch cannot download encrypted streams.",
      );
    }

    let videoPlaylistUrl = m3u8Url;
    let audioPlaylistUrl = null;
    const baseName = sanitizeFilenameSegment(document.title || "video_download");

    if (master.isMaster) {
      // Pick best variant
      const sorted = master.variants
        .slice()
        .sort((a, b) => b.bandwidth - a.bandwidth);
      if (sorted.length === 0) {
        throw new Error("No variants found in master playlist");
      }
      videoPlaylistUrl = sorted[0].url;
      Log.info(
        `HLS: picked variant ${sorted[0].resolution || "best"} (${sorted[0].bandwidth} bps)`,
      );

      // Check for separate audio rendition
      if (sorted[0].audioGroupId && master.audioRenditions.length > 0) {
        const audioRend = master.audioRenditions.find(
          (r) => r.groupId === sorted[0].audioGroupId,
        );
        if (audioRend) {
          audioPlaylistUrl = audioRend.url;
        }
      }
    }

    const videoSpec = await getHLSPlaylistSpec(videoPlaylistUrl, "video");
    if (isStale(dlId)) {
      return;
    }
    Log.info(
      `HLS[V]: ${videoSpec.urls.length} segments, ~${videoSpec.totalDuration.toFixed(0)}s, fMP4=${videoSpec.playlist.isFMP4}`,
    );

    let audioSpec = null;

    // Download audio segments if separate
    if (audioPlaylistUrl) {
      audioSpec = await getHLSPlaylistSpec(audioPlaylistUrl, "audio");
      Log.info(
        `HLS[A]: ${audioSpec.urls.length} segments, ~${audioSpec.totalDuration.toFixed(0)}s, fMP4=${audioSpec.playlist.isFMP4}`,
      );
    }

    const combinedEstimate =
      (videoSpec.estimatedBytes || 0) + (audioSpec?.estimatedBytes || 0);
    const shouldStreamToDisk =
      shouldStreamSegmentedDownload(
        videoSpec.urls,
        videoSpec.estimatedBytes,
        Boolean(audioSpec),
      ) ||
      (audioSpec &&
        shouldStreamSegmentedDownload(
          audioSpec.urls,
          combinedEstimate,
          true,
        ));

    if (shouldStreamToDisk) {
      if (audioSpec) {
        alert(
          "Large HLS streams with separate audio and video tracks will be saved as separate files to avoid exhausting browser memory.",
        );
      }
      await writeSequentialUrlsToFile(
        videoSpec.urls,
        `${baseName}_video.${videoSpec.ext}`,
        videoSpec.mime,
        btn,
        dlId,
        "V",
      );
      if (audioSpec && !isStale(dlId)) {
        await writeSequentialUrlsToFile(
          audioSpec.urls,
          `${baseName}_audio.${audioSpec.ext}`,
          audioSpec.mime,
          btn,
          dlId,
          "A",
        );
      }
      return;
    }

    const videoPayload = await collectUrlsToMemory(
      videoSpec.urls,
      btn,
      dlId,
      "V",
      MAX_IN_MEMORY_DOWNLOAD_BYTES,
    );
    if (isStale(dlId) || !videoPayload.blobs) {
      return;
    }
    const videoBlob = new Blob(videoPayload.blobs, { type: videoSpec.mime });

    if (audioSpec) {
      const audioPayload = await collectUrlsToMemory(
        audioSpec.urls,
        btn,
        dlId,
        "A",
        MAX_IN_MEMORY_DOWNLOAD_BYTES,
      );
      if (isStale(dlId) || !audioPayload.blobs) {
        return;
      }
      ensureMuxFitsMemory(videoPayload.totalBytes, audioPayload.totalBytes, "HLS");
      const audioBlob = new Blob(audioPayload.blobs, { type: audioSpec.mime });
      const muxed = await muxVideoAudio(videoBlob, audioBlob);
      if (muxed) {
        triggerBlobDownload(
          muxed,
          buildMediaFilename(baseName, muxed.type || "video/mp4", "mp4"),
        );
      } else {
        triggerBlobDownload(videoBlob, `${baseName}_video.${videoSpec.ext}`);
        setTimeout(
          () => triggerBlobDownload(audioBlob, `${baseName}_audio.${audioSpec.ext}`),
          500,
        );
      }
      return;
    }

    // Keep remux for smaller single-track HLS downloads only.
    let finalBlob = videoBlob;
    if (!isStale(dlId) && videoSpec.ext === "ts") {
      setBtnProgress(btn, "Remux...");
      const remuxed = await remuxToMP4(finalBlob, "ts");
      if (remuxed) {
        finalBlob = remuxed;
      }
    }

    if (!isStale(dlId)) {
      triggerBlobDownload(
        finalBlob,
        buildMediaFilename(baseName, finalBlob.type || videoSpec.mime, videoSpec.ext),
      );
    }
  }

  function buildDashTrackSpec(rep, trackType) {
    const mime =
      rep?.mime ||
      (trackType === "audio" ? "audio/mp4" : "video/mp4");
    return {
      estimatedBytes: null,
      ext: getMimeExtension(mime, trackType === "audio" ? "m4a" : "mp4"),
      mime,
      trackType,
      urls: rep?.segments || [],
    };
  }

  async function enrichDashTrackSpec(spec) {
    return {
      ...spec,
      estimatedBytes: await estimateSegmentedDownloadBytes(spec.urls),
    };
  }

  async function collectDashTrackToMemory(spec, btn, dlId, label) {
    if (spec.urls.length === 1) {
      const blob = await fetchBlob(spec.urls[0], (loaded, total) => {
        if (!isStale(dlId) && total) {
          setBtnProgress(btn, `${label} ${Math.round((loaded / total) * 100)}%`);
        }
      });
      return { blobs: [blob], totalBytes: blob.size };
    }
    return collectUrlsToMemory(
      spec.urls,
      btn,
      dlId,
      label,
      MAX_IN_MEMORY_DOWNLOAD_BYTES,
    );
  }

  // =========================================================================
  // SECTION 6: DASH / MPD PARSER + DOWNLOADER
  // Handles: BaseURL, SegmentTemplate ($Number$, $Time$), SegmentList, SegmentTimeline
  // =========================================================================

  function parseMPD(xmlText, mpdUrl) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const result = { video: [], audio: [] };

    doc.querySelectorAll("AdaptationSet").forEach((as) => {
      const mimeType = as.getAttribute("mimeType") || "";
      const contentType = as.getAttribute("contentType") || "";
      const isAudio =
        mimeType.includes("audio") || contentType.includes("audio");

      as.querySelectorAll("Representation").forEach((rep) => {
        const entry = {
          id: rep.getAttribute("id") || "",
          bandwidth: parseInt(rep.getAttribute("bandwidth") || "0", 10),
          width: parseInt(rep.getAttribute("width") || "0", 10),
          height: parseInt(rep.getAttribute("height") || "0", 10),
          mime: rep.getAttribute("mimeType") || mimeType,
          segments: [], // Array of URLs to download in order
        };

        // --- Strategy 1: BaseURL (single file) ---
        const baseUrlEl =
          rep.querySelector("BaseURL") || as.querySelector("BaseURL");
        if (baseUrlEl) {
          entry.segments = [new URL(baseUrlEl.textContent.trim(), mpdUrl).href];
        }

        // --- Strategy 2: SegmentTemplate ---
        const segTpl =
          rep.querySelector("SegmentTemplate") ||
          as.querySelector("SegmentTemplate");
        if (segTpl) {
          const media = segTpl.getAttribute("media") || "";
          const init = segTpl.getAttribute("initialization") || "";
          const startNumber = parseInt(
            segTpl.getAttribute("startNumber") || "1",
            10,
          );
          const timescale = parseInt(
            segTpl.getAttribute("timescale") || "1",
            10,
          );
          const duration = parseInt(segTpl.getAttribute("duration") || "0", 10);

          const repId = entry.id;
          const repBw = entry.bandwidth;

          const fillTemplate = (tpl, num, time) => {
            return tpl
              .replace(/\$RepresentationID\$/g, repId)
              .replace(/\$Bandwidth\$/g, String(repBw))
              .replace(/\$Number(%\d+d)?\$/g, (_, fmt) =>
                fmt
                  ? String(num).padStart(parseInt(fmt.slice(1), 10), "0")
                  : String(num),
              )
              .replace(/\$Time\$/g, String(time));
          };

          const segs = [];

          // Init segment
          if (init) {
            segs.push(new URL(fillTemplate(init, startNumber, 0), mpdUrl).href);
          }

          // Check for SegmentTimeline
          const timeline = segTpl.querySelector("SegmentTimeline");
          if (timeline) {
            const entries = timeline.querySelectorAll("S");
            let time = 0,
              num = startNumber;
            entries.forEach((s) => {
              const t = s.getAttribute("t")
                ? parseInt(s.getAttribute("t"), 10)
                : time;
              const d = parseInt(s.getAttribute("d") || "0", 10);
              const r = parseInt(s.getAttribute("r") || "0", 10);
              time = t;
              for (let j = 0; j <= r; j++) {
                segs.push(new URL(fillTemplate(media, num, time), mpdUrl).href);
                time += d;
                num++;
              }
            });
          } else if (duration > 0) {
            // Duration-based: estimate segment count from Period duration or a reasonable max
            const periodEl = as.closest("Period");
            let periodDurSec = 300; // default 5min
            if (periodEl?.getAttribute("duration")) {
              const pd = periodEl.getAttribute("duration");
              const m = pd.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
              if (m) {
                periodDurSec =
                  parseInt(m[1] || 0, 10) * 3600 +
                  parseInt(m[2] || 0, 10) * 60 +
                  parseFloat(m[3] || 0);
              }
            }
            const segDurSec = duration / timescale;
            const segCount = Math.ceil(periodDurSec / segDurSec);
            for (let n = startNumber; n < startNumber + segCount; n++) {
              segs.push(new URL(fillTemplate(media, n, 0), mpdUrl).href);
            }
          }

          if (segs.length > 0) {
            entry.segments = segs;
          }
        }

        // --- Strategy 3: SegmentList ---
        const segList =
          rep.querySelector("SegmentList") || as.querySelector("SegmentList");
        if (segList && entry.segments.length <= 1) {
          const segs = [];
          const initEl = segList.querySelector("Initialization");
          if (initEl?.getAttribute("sourceURL")) {
            segs.push(new URL(initEl.getAttribute("sourceURL"), mpdUrl).href);
          }
          segList.querySelectorAll("SegmentURL").forEach((su) => {
            const mediaUrl =
              su.getAttribute("media") || su.getAttribute("mediaURL");
            if (mediaUrl) {
              segs.push(new URL(mediaUrl, mpdUrl).href);
            }
          });
          if (segs.length > 0) {
            entry.segments = segs;
          }
        }

        if (entry.segments.length > 0) {
          (isAudio || entry.mime.includes("audio")
            ? result.audio
            : result.video
          ).push(entry);
        }
      });
    });

    // Sort by quality
    result.video.sort(
      (a, b) => b.height - a.height || b.bandwidth - a.bandwidth,
    );
    result.audio.sort((a, b) => b.bandwidth - a.bandwidth);

    return result;
  }

  async function downloadDASH(mpdUrl, btn, dlId) {
    Log.info("DASH download:", mpdUrl);
    const xmlText = await fetchText(mpdUrl);
    if (isStale(dlId)) {
      return;
    }

    const mpd = parseMPD(xmlText, mpdUrl);
    if (mpd.video.length === 0) {
      throw new Error("No video representations found in MPD");
    }

    const bestVideo = mpd.video[0];
    const bestAudio = mpd.audio.length > 0 ? mpd.audio[0] : null;
    const baseName = sanitizeFilenameSegment(document.title || "video_download");
    const videoSpec = await enrichDashTrackSpec(
      buildDashTrackSpec(bestVideo, "video"),
    );
    const audioSpec = bestAudio
      ? await enrichDashTrackSpec(buildDashTrackSpec(bestAudio, "audio"))
      : null;
    const combinedEstimate =
      (videoSpec.estimatedBytes || 0) + (audioSpec?.estimatedBytes || 0);

    Log.info(
      `DASH: video=${bestVideo.width}x${bestVideo.height} (${bestVideo.segments.length} segs), audio=${bestAudio ? bestAudio.segments.length + " segs" : "none"}`,
    );

    const shouldStreamToDisk =
      shouldStreamSegmentedDownload(
        videoSpec.urls,
        videoSpec.estimatedBytes,
        Boolean(audioSpec),
      ) ||
      (audioSpec &&
        shouldStreamSegmentedDownload(
          audioSpec.urls,
          combinedEstimate,
          true,
        ));

    if (shouldStreamToDisk) {
      if (audioSpec) {
        alert(
          "Large DASH streams with separate audio and video tracks will be saved as separate files to avoid exhausting browser memory.",
        );
      }
      await writeSequentialUrlsToFile(
        videoSpec.urls,
        `${baseName}_video.${videoSpec.ext}`,
        videoSpec.mime,
        btn,
        dlId,
        "V",
      );
      if (audioSpec && !isStale(dlId)) {
        await writeSequentialUrlsToFile(
          audioSpec.urls,
          `${baseName}_audio.${audioSpec.ext}`,
          audioSpec.mime,
          btn,
          dlId,
          "A",
        );
      }
      return;
    }

    setBtnProgress(btn, "V 0%");
    const videoPayload = await collectDashTrackToMemory(videoSpec, btn, dlId, "V");
    if (isStale(dlId) || !videoPayload.blobs) {
      return;
    }
    const videoBlob = new Blob(videoPayload.blobs, { type: videoSpec.mime });

    // Download audio segments
    if (audioSpec) {
      setBtnProgress(btn, "A 0%");
      const audioPayload = await collectDashTrackToMemory(
        audioSpec,
        btn,
        dlId,
        "A",
      );
      if (isStale(dlId) || !audioPayload.blobs) {
        return;
      }
      ensureMuxFitsMemory(
        videoPayload.totalBytes,
        audioPayload.totalBytes,
        "DASH",
      );
      const audioBlob = new Blob(audioPayload.blobs, { type: audioSpec.mime });

      // Mux
      btn.innerHTML = svgMux;
      const muxed = await muxVideoAudio(videoBlob, audioBlob);
      if (muxed) {
        triggerBlobDownload(
          muxed,
          buildMediaFilename(baseName, muxed.type || "video/mp4", "mp4"),
        );
      } else {
        triggerBlobDownload(videoBlob, `${baseName}_video.${videoSpec.ext}`);
        setTimeout(
          () => triggerBlobDownload(audioBlob, `${baseName}_audio.${audioSpec.ext}`),
          500,
        );
      }
    } else {
      // Video-only: remux to fix timestamp gaps in concatenated segments
      if (videoSpec.urls.length > 1) {
        setBtnProgress(btn, "Remux...");
        const remuxed = await remuxToMP4(
          videoBlob,
          videoSpec.ext === "ts" ? "ts" : "mp4",
        );
        if (remuxed) {
          triggerBlobDownload(
            remuxed,
            buildMediaFilename(baseName, remuxed.type, "mp4"),
          );
        } else {
          triggerBlobDownload(
            videoBlob,
            buildMediaFilename(baseName, videoBlob.type, videoSpec.ext),
          );
        }
      } else {
        triggerBlobDownload(
          videoBlob,
          buildMediaFilename(baseName, videoBlob.type, videoSpec.ext),
        );
      }
    }
  }

  // =========================================================================
  // SECTION 7: REACT FIBER & SITE-SPECIFIC EXTRACTORS
  // =========================================================================

  const ReactUtils = {
    getFiber(el) {
      if (!el) {
        return null;
      }
      for (const p of Object.keys(el)) {
        if (
          p.startsWith("__reactFiber") ||
          p.startsWith("__reactInternalInstance")
        ) {
          return el[p];
        }
      }
      return null;
    },
    returnUntil(fiber, pred) {
      let f = fiber;
      while (f) {
        if (pred(f)) {
          return f;
        }
        f = f.return;
      }
      return null;
    },
  };

  async function extractDirectVideoSrc(video) {
    try {
      // Facebook
      if (HOST.includes("facebook.com")) {
        const f =
          ReactUtils.getFiber(video) ||
          ReactUtils.getFiber(video.parentElement);
        const t = ReactUtils.returnUntil(
          f,
          (f) => f.memoizedProps?.implementations,
        );
        if (t) {
          const impl = t.memoizedProps.implementations.find((x) =>
            x.typename?.includes("VideoPlayer"),
          );
          if (impl) {
            return impl.data.hdSrc || impl.data.sdSrc;
          }
        }
      }
      // Twitter / X
      if (
        (HOST.includes("twitter.com") || HOST.includes("x.com")) &&
        settings.enableTwitter
      ) {
        if (video.dataset.twResolvedUrl) {
          return video.dataset.twResolvedUrl;
        }
        const f = ReactUtils.getFiber(video.parentElement?.parentElement);
        const t = ReactUtils.returnUntil(
          f,
          (f) => f.memoizedProps?.videoId?.id || f.memoizedProps?.contentId,
        );
        const twId =
          t?.memoizedProps?.videoId?.id || t?.memoizedProps?.contentId;
        if (twId) {
          try {
            const bearer =
              "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
            const tokenData = await fetchJSON(
              "https://api.twitter.com/1.1/guest/activate.json",
              { Authorization: bearer },
              "POST",
            );
            const data = await fetchJSON(
              `https://api.twitter.com/2/timeline/conversation/${twId}.json`,
              { Authorization: bearer, "X-Guest-Token": tokenData.guest_token },
            );
            const variants = data.globalObjects?.tweets[
              twId
            ]?.extended_entities?.media[0]?.video_info?.variants
              ?.filter((x) => x.content_type !== "application/x-mpegURL")
              .sort((a, b) => b.bitrate - a.bitrate);
            if (variants?.length > 0) {
              video.dataset.twResolvedUrl = variants[0].url;
              return variants[0].url;
            }
          } catch (e) {
            Log.debug("Twitter API extraction failed:", e.message);
          }
        }
      }
      // Reddit
      if (HOST.includes("reddit.com") && settings.enableReddit) {
        const directRedditSrc = normalizeRouteSource(
          video.currentSrc || video.src || video.querySelector("source")?.src,
        );
        if (directRedditSrc) {
          return directRedditSrc;
        }
        const post = video.closest("shreddit-post") || video.closest(".thing");
        let permalink = window.location.pathname;
        if (post?.getAttribute("permalink")) {
          permalink = post.getAttribute("permalink");
        } else if (post?.dataset?.permalink) {
          permalink = post.dataset.permalink;
        }
        return "reddit:" + window.location.origin + permalink;
      }
      // Instagram
      if (HOST.includes("instagram.com")) {
        const f =
          ReactUtils.getFiber(video) ||
          ReactUtils.getFiber(video.parentElement);
        const t = ReactUtils.returnUntil(
          f,
          (f) => f.memoizedProps?.videoUrl || f.memoizedProps?.src,
        );
        if (t) {
          return t.memoizedProps.videoUrl || t.memoizedProps.src;
        }
      }
      // TikTok
      if (HOST.includes("tiktok.com")) {
        const f =
          ReactUtils.getFiber(video) ||
          ReactUtils.getFiber(video.parentElement);
        const t = ReactUtils.returnUntil(
          f,
          (f) =>
            f.memoizedProps?.videoData?.downloadAddr ||
            f.memoizedProps?.videoData?.playAddr,
        );
        if (t) {
          return (
            t.memoizedProps.videoData.downloadAddr ||
            t.memoizedProps.videoData.playAddr
          );
        }
      }
      // Vimeo
      if (HOST.includes("vimeo.com")) {
        for (const s of document.querySelectorAll("script")) {
          if (s.textContent.includes('"progressive"')) {
            const m = s.textContent.match(/"progressive"\s*:\s*(\[.*?\])/s);
            if (m) {
              const progs = JSON.parse(m[1]).sort(
                (a, b) => (b.width || 0) - (a.width || 0),
              );
              if (progs[0]?.url) {
                return progs[0].url;
              }
            }
          }
        }
      }
      // Generic data attributes
      for (const attr of [
        "data-src",
        "data-video-url",
        "data-hls",
        "data-dash",
        "data-mpd-url",
        "data-stream-url",
      ]) {
        if (video.getAttribute(attr)) {
          return video.getAttribute(attr);
        }
      }
      // Framework players
      const playerContainer = video.closest(
        ".video-js, .plyr, .jwplayer, .flowplayer, [data-player]",
      );
      if (playerContainer) {
        const src =
          playerContainer.getAttribute("data-video-src") ||
          playerContainer.getAttribute("data-hls-url") ||
          playerContainer.getAttribute("data-dash-url");
        if (src) {
          return src;
        }
      }
    } catch (e) {
      Log.warn("Extractor exception:", e.message);
    }
    // Fallback
    return (
      video.dataset.mpdUrl ||
      video.currentSrc ||
      video.src ||
      video.querySelector("source")?.src ||
      null
    );
  }

  // =========================================================================
  // SECTION 8: DOWNLOAD LOCK + CANCEL SYSTEM
  // =========================================================================

  let activeVideoSrc = null;
  let activeVideoElement = null;
  let buttonContainer = null;
  let isDirectVideoTab = false;
  let currentDownloadId = 0;
  let lastAutoMSESignature = "";
  let sniffedManifestUrls = [];
  const sniffedManifestMeta = new Map();
  const videoListenerRegistry = new Map();
  const approvedSniffHosts = new Set();
  const approvedThirdPartyHosts = new Set();

  function isAutoDownloadEnabled() {
    return settings.autoDownloadMSE;
  }

  function syncActiveMSEState(preferredSource = activeVideoSrc) {
    const of = uWindow.__omnifetch || {};
    try {
      if (preferredSource && typeof of.selectSessionBySource === "function") {
        of.selectSessionBySource(preferredSource);
      } else if (typeof of.syncActiveSession === "function") {
        of.syncActiveSession();
      }
    } catch (e) {
      Log.debug("MSE session sync failed:", e.message);
    }
    return of;
  }

  function releaseActiveMSECapture(preferredSource = activeVideoSrc) {
    const of = uWindow.__omnifetch || {};
    try {
      if (
        preferredSource &&
        typeof of.releaseSessionBySource === "function" &&
        of.releaseSessionBySource(preferredSource)
      ) {
        Log.debug("Released completed MSE capture for", preferredSource);
      }
    } catch (e) {
      Log.debug("MSE release failed:", e.message);
    }
  }

  function getMSETrackChunkCount(of, kind) {
    const countKey = kind === "video" ? "videoChunkCount" : "audioChunkCount";
    const chunksKey = kind === "video" ? "videoChunks" : "audioChunks";
    const explicitCount = parseInt(of?.[countKey], 10);
    if (Number.isFinite(explicitCount)) {
      return explicitCount;
    }
    return Array.isArray(of?.[chunksKey]) ? of[chunksKey].length : 0;
  }

  function getMSETrackByteCount(of, kind) {
    return kind === "video" ? of?.totalVideoBytes || 0 : of?.totalAudioBytes || 0;
  }

  function hasMSETrackData(of, kind) {
    return (
      getMSETrackByteCount(of, kind) > 0 || getMSETrackChunkCount(of, kind) > 0
    );
  }

  function hasAnyMSETrackData(of) {
    return hasMSETrackData(of, "video") || hasMSETrackData(of, "audio");
  }

  function getMSETrackStorageMode(of, kind) {
    return kind === "video"
      ? of?.videoStorageMode || "memory"
      : of?.audioStorageMode || "memory";
  }

  async function getMSETrackBlob(
    of,
    kind,
    preferredSource = activeVideoSrc,
    fallbackMime = kind === "video" ? "video/mp4" : "audio/mp4",
  ) {
    if (typeof of?.getTrackBlobBySource === "function") {
      const exported = await of.getTrackBlobBySource(preferredSource || "", kind);
      if (exported) {
        return exported.type
          ? exported
          : exported.slice(0, exported.size, fallbackMime);
      }
    }

    const chunks = kind === "video" ? of?.videoChunks : of?.audioChunks;
    const mime = kind === "video" ? of?.videoMime : of?.audioMime;
    return createMediaBlob(chunks || [], mime, fallbackMime);
  }

  function getMSECaptureSignature(of) {
    const vCount = getMSETrackChunkCount(of, "video");
    const aCount = getMSETrackChunkCount(of, "audio");
    return [
      of.activeSessionId || "",
      of.captureLimitReached ? "truncated" : "complete",
      of.totalVideoBytes || 0,
      of.totalAudioBytes || 0,
      vCount,
      aCount,
      getMSETrackStorageMode(of, "video"),
      getMSETrackStorageMode(of, "audio"),
      of.videoMime || "",
      of.audioMime || "",
    ].join("|");
  }

  function sanitizeFilenameSegment(name) {
    return (name || "media")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function confirmPartialCaptureDownload(of, label = "This stream") {
    if (!of?.captureLimitReached) {
      return true;
    }
    const capturedMb = Math.round(
      ((of.totalVideoBytes || 0) + (of.totalAudioBytes || 0)) / 1048576,
    );
    return confirm(
      `${label} exceeded the OmniFetch MSE capture limit.\n\nCaptured so far: ${capturedMb} MB\nCapture cap: ${settings.maxMSEMemoryMB} MB\n\nDownload the partial capture anyway?`,
    );
  }

  function getAggregateMSEStorageMode(of) {
    const hasVideo = hasMSETrackData(of, "video");
    const hasAudio = hasMSETrackData(of, "audio");
    const videoMode = getMSETrackStorageMode(of, "video");
    const audioMode = getMSETrackStorageMode(of, "audio");

    if (hasVideo && hasAudio && videoMode !== audioMode) {
      return "mixed";
    }
    if (hasVideo) {
      return videoMode;
    }
    if (hasAudio) {
      return audioMode;
    }
    return of?.diskCaptureAvailable ? "opfs" : "memory";
  }

  function updateMSEStatusIndicator(src = activeVideoSrc) {
    const indicator = document.getElementById("omnifetch-mse-status");
    if (!indicator) {
      return;
    }

    const routedSrc = normalizeRouteSource(src);
    if (!routedSrc || !isBlobUrl(routedSrc)) {
      indicator.style.display = "none";
      indicator.dataset.mode = "";
      indicator.title = "";
      return;
    }

    const of = syncActiveMSEState(routedSrc);
    const totalBytes = (of.totalVideoBytes || 0) + (of.totalAudioBytes || 0);
    const mode = getAggregateMSEStorageMode(of).toUpperCase();
    const state = of.captureLimitReached
      ? "partial"
      : of.mseComplete
        ? "complete"
        : "capturing";

    indicator.dataset.mode = mode.toLowerCase();
    indicator.style.display = "flex";
    indicator.querySelector(".omnifetch-mse-status-top").textContent =
      `${mode} | ${formatBytes(totalBytes)}`;
    indicator.querySelector(".omnifetch-mse-status-bottom").textContent =
      formatExactBytes(totalBytes);
    indicator.title =
      `State: ${state}\n` +
      `Total: ${formatExactBytes(totalBytes)}\n` +
      `Video: ${formatExactBytes(of.totalVideoBytes || 0)} (${getMSETrackStorageMode(of, "video")})\n` +
      `Audio: ${formatExactBytes(of.totalAudioBytes || 0)} (${getMSETrackStorageMode(of, "audio")})\n` +
      `Chunks: video=${getMSETrackChunkCount(of, "video")}, audio=${getMSETrackChunkCount(of, "audio")}\n` +
      `Active session: ${of.activeSessionId || "none"}`;
  }

  function isThirdPartyRedditEnabled() {
    return !isStrictSecurityMode() && settings.enableThirdPartyReddit;
  }

  function rememberApprovedHost(cacheKey, host) {
    approvedThirdPartyHosts.add(`${cacheKey}:${host.toLowerCase()}`);
  }

  function hasApprovedHost(cacheKey, host) {
    return approvedThirdPartyHosts.has(`${cacheKey}:${host.toLowerCase()}`);
  }

  function confirmThirdPartyHost(url, serviceLabel, cacheKey) {
    const safe = toHttpUrl(url);
    if (!safe) {
      return false;
    }
    if (hasApprovedHost(cacheKey, safe.host)) {
      return true;
    }
    const approved = confirm(
      `${serviceLabel} will open an external download page.\n\nHost: ${safe.host}\nURL: ${redactUrlForReport(safe.href)}\n\nOnly continue if you trust this destination.`,
    );
    if (approved) {
      rememberApprovedHost(cacheKey, safe.host);
    }
    return approved;
  }

  function confirmSniffedManifestRoute(routeUrl) {
    const safe = toHttpUrl(routeUrl);
    if (!safe) {
      return false;
    }
    if (approvedSniffHosts.has(safe.host.toLowerCase())) {
      return true;
    }
    const approved = confirm(
      `OmniFetch only detected this media route through network sniffing.\n\nHost: ${safe.host}\nRoute: ${redactUrlForReport(safe.href)}\n\nThis may belong to ads or unrelated media. Continue with this manifest?`,
    );
    if (approved) {
      approvedSniffHosts.add(safe.host.toLowerCase());
    }
    return approved;
  }

  function getPreferredSniffRoute() {
    const url = pickPreferredManifestUrl(sniffedManifestUrls);
    return url ? buildSniffRoute(url) : null;
  }

  function maybeAutoDownloadMSE(
    trigger = "event",
    preferredSource = activeVideoSrc,
  ) {
    if (!isAutoDownloadEnabled() || !isIdle()) {
      return;
    }
    const source = preferredSource || activeVideoSrc;
    if (!source || !isBlobUrl(source)) {
      return;
    }

    const of = syncActiveMSEState(source);
    const hasVideo = hasMSETrackData(of, "video");
    if (!of.mseComplete || !hasVideo) {
      return;
    }
    if (of.captureLimitReached) {
      Log.warn("Auto-download skipped because capture is partial/truncated.");
      return;
    }

    const signature = getMSECaptureSignature(of);
    if (signature === lastAutoMSESignature) {
      return;
    }
    lastAutoMSESignature = signature;

    const btn = document.getElementById("omnifetch-dl-btn");
    if (!btn) {
      return;
    }

    Log.info(`Auto-download requested (${trigger}).`);
    triggerMSEDownload(btn).catch((e) =>
      Log.warn("Auto-download failed:", e.message),
    );
  }

  function stripIframeSandboxAttributes() {
    if (isStrictSecurityMode() || !settings.removeIframeSandbox) {
      return;
    }
    document.querySelectorAll("iframe[sandbox]").forEach((iframe) => {
      try {
        iframe.removeAttribute("sandbox");
      } catch (e) {
        Log.debug("Sandbox strip skipped:", e.message);
      }
    });
  }

  function startDownload() {
    // Cancel any previous in-flight download
    if (currentDownloadId !== 0) {
      abortAllRequests();
    }
    currentDownloadId = Date.now() + Math.random();
    return currentDownloadId;
  }
  function isStale(dlId) {
    return currentDownloadId !== dlId;
  }
  function finishDownload(dlId) {
    if (currentDownloadId === dlId) {
      currentDownloadId = 0;
    }
  }
  function isIdle() {
    return currentDownloadId === 0;
  }

  function cancelCurrentDownload() {
    if (currentDownloadId === 0) {
      return;
    }
    Log.info("Download cancelled by user");
    abortAllRequests();
    currentDownloadId = 0;
    hideProgressOverlay();
    const btn = document.getElementById("omnifetch-dl-btn");
    if (btn) {
      resetBtn(btn);
    }
  }

  window.addEventListener("omnifetch-url-sniffed", (e) => {
    const url = e.detail?.url;
    if (isHlsManifestUrl(url) || isDashManifestUrl(url)) {
      const safe = toHttpUrl(url);
      if (safe) {
        sniffedManifestMeta.set(safe.href, {
          host: safe.host,
          lastSeenAt: Date.now(),
        });
        pushUniqueCapped(
          sniffedManifestUrls,
          safe.href,
          settings.maxSniffedUrls,
        );
        for (const knownUrl of [...sniffedManifestMeta.keys()]) {
          if (!sniffedManifestUrls.includes(knownUrl)) {
            sniffedManifestMeta.delete(knownUrl);
          }
        }
        Log.debug("Sniffed manifest:", safe.href);
      }
    }
  });

  window.addEventListener("omnifetch-auto-download-request", (e) =>
    maybeAutoDownloadMSE("page-hook", e.detail?.sourceUrl || activeVideoSrc),
  );

  // =========================================================================
  // SECTION 9: UI (button, progress overlay, settings panel)
  // =========================================================================

  const svgDownload = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const svgRecording = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="red" stroke-width="2.5"><circle cx="12" cy="12" r="8" fill="red"><animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite"/></circle></svg>`;
  const svgCheck = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34C759" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const svgSettings = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  const svgMux = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#AF52DE" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`;
  const svgCancel = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  function setBtnProgress(btn, text) {
    if (!btn) {
      return;
    }
    btn.innerHTML = `<span style="font-size:11px;font-weight:700;color:#007AFF;font-family:system-ui;white-space:nowrap">${text}</span>`;
    btn.style.cursor = "wait";
    // Show cancel button
    const cancelBtn = document.getElementById("omnifetch-cancel-btn");
    if (cancelBtn) {
      cancelBtn.style.display = "flex";
    }
  }

  function resetBtn(btn) {
    if (!btn) {
      return;
    }
    btn.innerHTML = svgDownload;
    btn.style.backgroundColor = "rgba(255,255,255,0.9)";
    btn.style.cursor = "pointer";
    const cancelBtn = document.getElementById("omnifetch-cancel-btn");
    if (cancelBtn) {
      cancelBtn.style.display = "none";
    }
  }

  function showProgressOverlay(msg) {
    let ov = document.getElementById("omnifetch-mux-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "omnifetch-mux-overlay";
      ov.style.cssText =
        "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999999;flex-direction:column;gap:16px";
      document.body.appendChild(ov);
    }
    ov.innerHTML = `<div style="background:#1a1a2e;padding:32px 48px;border-radius:16px;text-align:center;box-shadow:0 8px 32px rgba(0,122,255,0.3)"><div style="width:48px;height:48px;border:4px solid rgba(255,255,255,0.2);border-top-color:#007AFF;border-radius:50%;animation:omnifetch-spin 0.8s linear infinite;margin:0 auto 16px"></div><p style="color:white;font-size:16px;margin:0;font-family:system-ui">${msg}</p><p style="color:#888;font-size:12px;margin:8px 0 0;font-family:system-ui">FFmpeg.wasm — no re-encoding</p></div><style>@keyframes omnifetch-spin{to{transform:rotate(360deg)}}</style>`;
    ov.style.display = "flex";
  }

  function hideProgressOverlay() {
    const ov = document.getElementById("omnifetch-mux-overlay");
    if (ov) {
      ov.style.display = "none";
    }
  }

  function createUI() {
    if (document.getElementById("omnifetch-container")) {
      return document.getElementById("omnifetch-dl-btn");
    }
    const style = document.createElement("style");
    style.textContent = `
            @keyframes omnifetch-outline-pulse{0%,100%{outline-color:rgba(0,122,255,0.4)}50%{outline-color:rgba(0,122,255,0.85)}}
            .omnifetch-active-video{outline:3px solid rgba(0,122,255,0.6);outline-offset:-3px;animation:omnifetch-outline-pulse 2.5s ease-in-out infinite}
            #omnifetch-container{position:fixed;bottom:30px;right:20px;z-index:999999;display:none;font-family:system-ui,-apple-system,sans-serif;gap:8px;flex-direction:column;align-items:flex-end}
            .omnifetch-btn{background:rgba(255,255,255,0.9);color:#007AFF;width:50px;height:50px;border-radius:25px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.4);cursor:pointer;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:all 0.2s ease;text-decoration:none;border:none;outline:none;-webkit-tap-highlight-color:transparent}
            .omnifetch-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,0.5)}
            .omnifetch-btn:active{transform:scale(0.95)}
            .omnifetch-small-btn{width:32px;height:32px;border-radius:16px;background:rgba(255,255,255,0.85)}
            #omnifetch-sniff-badge{position:absolute;top:-4px;right:-4px;background:#FF3B30;color:white;font-size:10px;font-weight:700;border-radius:10px;min-width:18px;height:18px;display:none;align-items:center;justify-content:center;line-height:1;padding:0 4px}
            #omnifetch-mse-status{display:none;flex-direction:column;align-items:flex-end;gap:2px;min-width:198px;padding:8px 10px;border-radius:12px;background:rgba(12,18,28,0.88);color:#F5F7FA;box-shadow:0 6px 18px rgba(0,0,0,0.34);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
            #omnifetch-mse-status[data-mode="opfs"]{border:1px solid rgba(52,199,89,0.45)}
            #omnifetch-mse-status[data-mode="memory"]{border:1px solid rgba(255,159,10,0.45)}
            #omnifetch-mse-status[data-mode="mixed"]{border:1px solid rgba(175,82,222,0.45)}
            .omnifetch-mse-status-top{font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase}
            .omnifetch-mse-status-bottom{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;line-height:1.2}
            #omnifetch-settings-panel{display:none;position:fixed;bottom:100px;right:20px;z-index:9999999;background:#1a1a2e;color:white;padding:20px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:system-ui;font-size:13px;min-width:280px}
            #omnifetch-settings-panel label{display:flex;justify-content:space-between;align-items:center;padding:6px 0;gap:12px}
            #omnifetch-settings-panel input[type=checkbox]{width:18px;height:18px;accent-color:#007AFF}
            #omnifetch-settings-panel input[type=number]{width:60px;background:#2a2a4a;color:white;border:1px solid #444;border-radius:4px;padding:2px 6px;text-align:right}
            #omnifetch-settings-panel hr{border:none;border-top:1px solid #333;margin:8px 0}
            .omnifetch-settings-btn{background:#007AFF;color:white;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;margin-top:8px}
            .omnifetch-settings-btn:hover{background:#0066DD}
        `;
    document.head.appendChild(style);

    buttonContainer = document.createElement("div");
    buttonContainer.id = "omnifetch-container";

    // Main download button
    const btn = document.createElement("a");
    btn.id = "omnifetch-dl-btn";
    btn.className = "omnifetch-btn";
    btn.innerHTML = svgDownload;
    btn.title = "Download video";

    const badge = document.createElement("div");
    badge.id = "omnifetch-sniff-badge";
    badge.textContent = "0";

    // Cancel button (hidden by default)
    const cancelBtn = document.createElement("a");
    cancelBtn.id = "omnifetch-cancel-btn";
    cancelBtn.className = "omnifetch-btn omnifetch-small-btn";
    cancelBtn.innerHTML = svgCancel;
    cancelBtn.title = "Cancel download";
    cancelBtn.style.display = "none";
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      cancelCurrentDownload();
    };

    // Settings button
    const settingsBtn = document.createElement("a");
    settingsBtn.id = "omnifetch-settings-btn";
    settingsBtn.className = "omnifetch-btn omnifetch-small-btn";
    settingsBtn.innerHTML = svgSettings;
    settingsBtn.title = "OmniFetch settings";
    settingsBtn.onclick = (e) => {
      e.preventDefault();
      toggleSettingsPanel();
    };

    const btnWrap = document.createElement("div");
    btnWrap.style.cssText = "position:relative;display:inline-block";
    btnWrap.append(btn, badge);

    const mseStatus = document.createElement("div");
    mseStatus.id = "omnifetch-mse-status";
    mseStatus.innerHTML =
      '<div class="omnifetch-mse-status-top">MSE | 0 B</div><div class="omnifetch-mse-status-bottom">0 B</div>';

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center";
    row.append(cancelBtn, settingsBtn);

    buttonContainer.append(mseStatus, btnWrap, row);
    document.body.appendChild(buttonContainer);

    createSettingsPanel();

    return btn;
  }

  function createSettingsPanel() {
    if (document.getElementById("omnifetch-settings-panel")) {
      return;
    }
    const panel = document.createElement("div");
    panel.id = "omnifetch-settings-panel";
    panel.innerHTML = `
            <div style="font-size:16px;font-weight:700;margin-bottom:12px">OmniFetch Settings</div>
            <label>Enable on this site <input type="checkbox" id="of-site-enabled" ${isSiteEnabled() ? "checked" : ""}></label>
            <hr>
            <div style="font-size:12px;font-weight:600;color:#8888aa;margin-bottom:4px">Platform Modules</div>
            <label>Telegram <input type="checkbox" id="of-tg" ${settings.enableTelegram ? "checked" : ""}></label>
            <label>YouTube <input type="checkbox" id="of-yt" ${settings.enableYouTube ? "checked" : ""}></label>
            <label>Twitter / X <input type="checkbox" id="of-tw" ${settings.enableTwitter ? "checked" : ""}></label>
            <label>Reddit <input type="checkbox" id="of-rd" ${settings.enableReddit ? "checked" : ""}></label>
            <hr>
            <div style="font-size:12px;font-weight:600;color:#8888aa;margin-bottom:4px">Engine</div>
            <label>Strict security mode <input type="checkbox" id="of-strict" ${isStrictSecurityMode() ? "checked" : ""}></label>
            <label>MSE buffer capture <input type="checkbox" id="of-mse" ${settings.enableMSECapture ? "checked" : ""}></label>
            <label>Network sniffing <input type="checkbox" id="of-sniff" ${settings.enableNetworkSniff ? "checked" : ""}></label>
            <label>Auto-download completed MSE <input type="checkbox" id="of-auto-mse" ${settings.autoDownloadMSE ? "checked" : ""}></label>
            <label>Remove iframe sandbox (risky) <input type="checkbox" id="of-strip-sandbox" ${settings.removeIframeSandbox ? "checked" : ""}></label>
            <label>Reddit via RapidSave (3rd-party) <input type="checkbox" id="of-rd3p" ${settings.enableThirdPartyReddit ? "checked" : ""}></label>
            <label>YouTube 3rd-party converter <input type="checkbox" id="of-yt3p" ${settings.enableThirdPartyYT ? "checked" : ""}></label>
            <hr>
            <label>MSE memory cap (MB) <input type="number" id="of-mse-cap" value="${settings.maxMSEMemoryMB}" min="${MIN_MSE_MEMORY_MB}" max="${HARD_MAX_MSE_MEMORY_MB}"></label>
            <label>HLS concurrency <input type="number" id="of-hls-conc" value="${settings.hlsConcurrency}" min="1" max="8"></label>
            <label>Sniffed URL cap <input type="number" id="of-sniff-cap" value="${settings.maxSniffedUrls}" min="20" max="2000"></label>
            <label>Request timeout (s) <input type="number" id="of-timeout" value="${settings.requestTimeoutBlob / 1000}" min="5" max="300"></label>
            <label>Max retries <input type="number" id="of-retries" value="${settings.maxRetries}" min="0" max="5"></label>
            <hr>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="omnifetch-settings-btn" id="of-save-btn">Save &amp; Reload</button>
                <button class="omnifetch-settings-btn" id="of-debug-btn" style="background:#555">Copy Debug Report</button>
            </div>
            <p style="color:#666;font-size:10px;margin:8px 0 0">v${SCRIPT_VERSION} · Changes apply after page reload</p>
        `;
    document.body.appendChild(panel);

    document.getElementById("of-save-btn").onclick = () => {
      const isStrictModeEnabled = document.getElementById("of-strict").checked;
      settings.enabledSites[HOST] =
        document.getElementById("of-site-enabled").checked;
      settings.enableTelegram = document.getElementById("of-tg").checked;
      settings.enableYouTube = document.getElementById("of-yt").checked;
      settings.enableTwitter = document.getElementById("of-tw").checked;
      settings.enableReddit = document.getElementById("of-rd").checked;
      settings.strictSecurityMode = isStrictModeEnabled;
      settings.enableMSECapture = document.getElementById("of-mse").checked;
      settings.enableNetworkSniff = document.getElementById("of-sniff").checked;
      settings.autoDownloadMSE = document.getElementById("of-auto-mse").checked;
      settings.removeIframeSandbox =
        !isStrictModeEnabled &&
        document.getElementById("of-strip-sandbox").checked;
      settings.enableThirdPartyReddit =
        !isStrictModeEnabled && document.getElementById("of-rd3p").checked;
      settings.enableThirdPartyYT =
        !isStrictModeEnabled && document.getElementById("of-yt3p").checked;
      settings.maxMSEMemoryMB = readIntegerInput(
        "of-mse-cap",
        DEFAULT_MSE_MEMORY_MB,
        MIN_MSE_MEMORY_MB,
        HARD_MAX_MSE_MEMORY_MB,
      );
      settings.hlsConcurrency = readIntegerInput("of-hls-conc", 4, 1, 8);
      settings.maxSniffedUrls = readIntegerInput("of-sniff-cap", 200, 20, 2000);
      settings.requestTimeoutBlob =
        readIntegerInput("of-timeout", 60, 5, 300) * 1000;
      settings.maxRetries = readIntegerInput("of-retries", 2, 0, 5);
      enforceSecurityPolicy();
      saveSettings();
      syncLegacyCompatFlags();
      window.location.reload();
    };

    document.getElementById("of-debug-btn").onclick = () => {
      const report = Log.exportReport();
      navigator.clipboard
        .writeText(report)
        .then(() => alert("Redacted debug report copied to clipboard!"))
        .catch(() => {
          // Fallback
          const ta = document.createElement("textarea");
          ta.value = report;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          alert("Redacted debug report copied!");
        });
    };
  }

  function toggleSettingsPanel() {
    const panel = document.getElementById("omnifetch-settings-panel");
    if (panel) {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    }
  }

  // =========================================================================
  // SECTION 10: DOWNLOAD ROUTERS (all use download-ID lock + try/finally)
  // =========================================================================

  async function triggerYT3PDownload(url, btn) {
    if (isStrictSecurityMode()) {
      alert(
        "Strict security mode is enabled.\n\nDisable Strict security mode in OmniFetch settings to allow 3rd-party YouTube conversion.",
      );
      return;
    }
    if (!settings.enableThirdPartyYT) {
      alert(
        "YouTube 3rd-party downloading is disabled.\n\nEnable it in OmniFetch settings (gear icon) if you accept the privacy/reliability risks of using external conversion services.",
      );
      return;
    }
    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    // Pre-open tab synchronously to avoid popup blocker
    const tab = window.open("about:blank", "_blank");
    try {
      const fd = new FormData();
      fd.set("q", url);
      fd.set("vt", "mp4");
      const resp = await gmRequest({
        method: "POST",
        url: "https://yt1s.com/api/ajaxSearch/index",
        data: fd,
        timeout: 20000,
      });
      if (isStale(dlId)) {
        if (tab) {
          tab.close();
        }
        return;
      }
      const js = JSON.parse(resp.responseText);
      const fd2 = new FormData();
      fd2.set("vid", js.vid);
      const k = js.links?.mp4?.auto
        ? js.links.mp4.auto.k
        : Object.values(js.links?.mp4 || {})[0]?.k;
      if (!k) {
        throw new Error("No conversion key found");
      }
      fd2.set("k", k);
      btn.innerHTML = svgSettings;
      const res2 = await gmRequest({
        method: "POST",
        url: "https://yt1s.com/api/ajaxConvert/convert",
        data: fd2,
        timeout: 60000,
      });
      if (isStale(dlId)) {
        if (tab) {
          tab.close();
        }
        return;
      }
      const js2 = JSON.parse(res2.responseText);
      if (js2.c_status === "CONVERTED" && js2.dlink) {
        if (
          !confirmThirdPartyHost(
            js2.dlink,
            "The YouTube converter",
            "ytThirdPartyDownload",
          )
        ) {
          if (tab) {
            tab.close();
          }
          return;
        }
        if (!navigateDetachedTab(tab, js2.dlink)) {
          throw new Error("Blocked unsafe converter download URL");
        }
      } else {
        if (tab) {
          tab.close();
        }
        alert(
          "YouTube conversion failed. Try a different video or disable 3rd-party in settings.",
        );
      }
    } catch (e) {
      if (tab) {
        tab.close();
      }
      if (!isStale(dlId)) {
        Log.error("YT3P download:", e.message);
      }
    } finally {
      if (!isStale(dlId)) {
        resetBtn(btn);
      }
      finishDownload(dlId);
    }
  }

  async function triggerDASHDownload(mpdUrl, btn) {
    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    try {
      await downloadDASH(mpdUrl, btn, dlId);
    } catch (e) {
      if (!isStale(dlId)) {
        Log.error("DASH:", e.message);
        alert("DASH download failed: " + e.message);
      }
    } finally {
      if (!isStale(dlId)) {
        resetBtn(btn);
      }
      finishDownload(dlId);
    }
  }

  async function triggerHLSDownload(m3u8Url, btn) {
    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    try {
      await downloadHLS(m3u8Url, btn, dlId);
    } catch (e) {
      if (!isStale(dlId)) {
        Log.error("HLS:", e.message);
        alert("HLS download failed: " + e.message);
      }
    } finally {
      if (!isStale(dlId)) {
        resetBtn(btn);
      }
      finishDownload(dlId);
    }
  }

  async function triggerNativeDownload(url, btn) {
    const safeUrl = toHttpUrl(url);
    if (!safeUrl) {
      Log.warn("Blocked unsafe native download URL:", url);
      alert("Blocked unsafe download URL.");
      return;
    }

    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    const filename = (() => {
      const path = safeUrl.pathname.split("/").pop() || "";
      let decoded = path;
      try {
        decoded = decodeURIComponent(path || "");
      } catch {
        decoded = path;
      }
      const clean = sanitizeFilenameSegment(decoded);
      return clean.match(/\.[a-zA-Z0-9]{2,5}$/) ? clean : "video_download.mp4";
    })();
    try {
      if (typeof GM_download === "function") {
        await new Promise((resolve, reject) => {
          GM_download({
            url: safeUrl.href,
            name: filename,
            saveAs: true,
            headers: { Referer: window.location.href },
            timeout: settings.requestTimeoutBlob,
            onload: resolve,
            onerror: (e) => reject(new Error(e?.error || "GM_download failed")),
            ontimeout: () => reject(new Error("Download timeout")),
          });
        });
      } else {
        if (await maybeDownloadDirectToFile(safeUrl.href, filename, btn, dlId)) {
          return;
        }
        const probe = await probeRemoteResource(safeUrl.href);
        if (!Number.isFinite(probe.length)) {
          throw new Error(
            "Unable to determine a safe in-memory size for this file. Handing off to the browser download path instead.",
          );
        }
        if (
          Number.isFinite(probe.length) &&
          probe.length > MAX_IN_MEMORY_DOWNLOAD_BYTES
        ) {
          throw new Error(
            `Direct download is ${formatBytes(probe.length)}, which exceeds OmniFetch's safe in-memory limit. Use Tampermonkey GM_download or a Chromium browser with File System Access support for large files.`,
          );
        }
        const blob = await fetchBlob(safeUrl.href, (loaded, total) => {
          if (!isStale(dlId) && total) {
            setBtnProgress(btn, Math.round((loaded / total) * 100) + "%");
          }
        });
        if (!isStale(dlId)) {
          triggerBlobDownload(blob, filename);
        }
      }
    } catch (e) {
      Log.warn("Native download fallback:", e.message);
      if (!isStale(dlId)) {
        const a = document.createElement("a");
        a.href = safeUrl.href;
        a.download = filename;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      if (!isStale(dlId)) {
        resetBtn(btn);
      }
      finishDownload(dlId);
    }
  }

  async function triggerMSEDownload(btn, sourceUrl = activeVideoSrc) {
    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    try {
      const of = syncActiveMSEState(sourceUrl);
      const hasVideo = hasMSETrackData(of, "video");
      const hasAudio = hasMSETrackData(of, "audio");
      let didDownload = false;
      if (!hasVideo) {
        alert(
          "No captured video data.\nLet the video play to completion first.",
        );
        return;
      }
      if (!confirmPartialCaptureDownload(of, "This video")) {
        return;
      }

      const baseName = sanitizeFilenameSegment(
        document.title || "video_download",
      );
      const videoBlob = await getMSETrackBlob(
        of,
        "video",
        sourceUrl,
        "video/mp4",
      );
      if (hasAudio) {
        const audioBlob = await getMSETrackBlob(
          of,
          "audio",
          sourceUrl,
          "audio/mp4",
        );
        const muxPlan = buildMuxPlan(videoBlob.type, audioBlob.type);
        btn.innerHTML = svgMux;
        let muxed = null;
        try {
          ensureMuxFitsMemory(
            of.totalVideoBytes,
            of.totalAudioBytes,
            "MSE capture",
          );
          muxed = await muxVideoAudio(videoBlob, audioBlob, muxPlan);
        } catch (muxGuardError) {
          Log.warn(muxGuardError.message);
        }
        if (isStale(dlId)) {
          return;
        }
        if (muxed) {
          triggerBlobDownload(
            muxed,
            buildMediaFilename(
              baseName,
              muxed.type || muxPlan.outputMime,
              muxPlan.outputExt,
            ),
          );
          didDownload = true;
        } else {
          triggerBlobDownload(
            videoBlob,
            buildMediaFilename(
              baseName + "_video",
              videoBlob.type,
              muxPlan.inputVideoExt,
            ),
          );
          setTimeout(
            () =>
              triggerBlobDownload(
                audioBlob,
                buildMediaFilename(
                  baseName + "_audio",
                  audioBlob.type,
                  muxPlan.inputAudioExt,
                ),
              ),
            500,
          );
          didDownload = true;
        }
      } else {
        triggerBlobDownload(
          videoBlob,
          buildMediaFilename(baseName, videoBlob.type, "mp4"),
        );
        didDownload = true;
      }
      if (didDownload) {
        releaseActiveMSECapture(sourceUrl);
      }
    } catch (e) {
      if (!isStale(dlId)) {
        Log.error("MSE download:", e.message);
        alert("MSE download failed: " + e.message);
      }
    } finally {
      if (!isStale(dlId)) {
        resetBtn(btn);
      }
      finishDownload(dlId);
    }
  }

  // =========================================================================
  // SECTION 11: DOWNLOAD LINK ROUTING
  // =========================================================================

  function updateDownloadLink(src) {
    let btn = document.getElementById("omnifetch-dl-btn");
    if (!btn) {
      btn = createUI();
    }
    const badge = document.getElementById("omnifetch-sniff-badge");
    const routedSrc = normalizeRouteSource(src);
    const sniffRouteTarget = parseSniffRoute(routedSrc);

    updateMSEStatusIndicator(routedSrc);

    if (badge && sniffedManifestUrls.length > 0) {
      badge.textContent = sniffedManifestUrls.length;
      badge.style.display = "flex";
    }

    // Don't overwrite button while a download is active
    if (!isIdle()) {
      buttonContainer.style.display = "flex";
      return;
    }

    if (!routedSrc) {
      buttonContainer.style.display = "none";
      return;
    }

    if (routedSrc.startsWith("reddit:") && settings.enableReddit) {
      const realUrl = routedSrc.split("reddit:")[1];
      if (!isThirdPartyRedditEnabled()) {
        btn.innerHTML = svgSettings;
        btn.title = "Reddit third-party downloader is disabled";
        btn.style.cursor = "pointer";
        btn.onclick = (e) => {
          e.preventDefault();
          alert(
            "Reddit third-party downloading is disabled.\n\nEnable 'Reddit via RapidSave (3rd-party)' in OmniFetch settings if you explicitly want to use RapidSave.",
          );
        };
      } else {
        resetBtn(btn);
        btn.title = "Download Reddit media via RapidSave";
        btn.onclick = (e) => {
          e.preventDefault();
          if (!isIdle()) {
            return;
          }
          const rapidSaveUrl =
            "https://rapidsave.com/info?url=" + encodeURIComponent(realUrl);
          if (
            !confirmThirdPartyHost(rapidSaveUrl, "RapidSave", "rapidSaveReddit")
          ) {
            return;
          }
          openInNewTab(rapidSaveUrl);
        };
      }
    } else if (sniffRouteTarget) {
      const safeSniffUrl = toHttpUrl(sniffRouteTarget);
      resetBtn(btn);
      btn.title = safeSniffUrl
        ? `Download sniffed manifest from ${safeSniffUrl.host}`
        : "Download sniffed manifest";
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) {
          return;
        }
        if (!confirmSniffedManifestRoute(sniffRouteTarget)) {
          return;
        }
        if (isDashManifestUrl(sniffRouteTarget)) {
          triggerDASHDownload(sniffRouteTarget, btn);
        } else if (isHlsManifestUrl(sniffRouteTarget)) {
          triggerHLSDownload(sniffRouteTarget, btn);
        } else {
          alert("Unsupported sniffed manifest route.");
        }
      };
    } else if (
      HOST.includes("youtube.com") &&
      settings.enableYouTube &&
      !isBlobUrl(routedSrc)
    ) {
      resetBtn(btn);
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) {
          return;
        }
        triggerYT3PDownload(window.location.href, btn);
      };
    } else if (isDashManifestUrl(routedSrc)) {
      btn.innerHTML = svgSettings;
      btn.style.cursor = "pointer";
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) {
          return;
        }
        triggerDASHDownload(routedSrc, btn);
      };
    } else if (isHlsManifestUrl(routedSrc)) {
      resetBtn(btn);
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) {
          return;
        }
        triggerHLSDownload(routedSrc, btn);
      };
    } else if (isBlobUrl(routedSrc)) {
      const of = syncActiveMSEState(routedSrc);
      if (of.mseComplete) {
        const hasAudio = hasMSETrackData(of, "audio");
        const hasVideo = hasMSETrackData(of, "video");
        btn.innerHTML = hasAudio && hasVideo ? svgMux : svgCheck;
        btn.title = of.captureLimitReached
          ? "Download partial captured stream"
          : hasAudio && hasVideo
            ? "Download muxed video+audio"
            : "Download captured video";
        btn.style.cursor = "pointer";
        btn.onclick = (e) => {
          e.preventDefault();
          if (!isIdle()) {
            return;
          }
          triggerMSEDownload(btn, routedSrc);
        };
      } else {
        btn.innerHTML = svgRecording;
        btn.title = `Buffering (${formatBytes((of.totalVideoBytes || 0) + (of.totalAudioBytes || 0))}) — let video play to end`;
        btn.style.cursor = "pointer";
        btn.onclick = (e) => {
          e.preventDefault();
          alert(
            "Stream is still buffering.\nLet the video play to the end, then click again.",
          );
        };
      }
    } else {
      resetBtn(btn);
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) {
          return;
        }
        triggerNativeDownload(routedSrc, btn);
      };
    }
    buttonContainer.style.display = "flex";
  }

  window.addEventListener("omnifetch-mse-complete", (e) => {
    const sourceUrl = e.detail?.sourceUrl || activeVideoSrc;
    if (!activeVideoSrc && sourceUrl) {
      activeVideoSrc = sourceUrl;
    }
    if (activeVideoSrc) {
      syncActiveMSEState(activeVideoSrc);
      updateDownloadLink(activeVideoSrc);
    }
    maybeAutoDownloadMSE("mse-complete", sourceUrl);
  });

  // =========================================================================
  // SECTION 12: VIDEO DETECTION (event-driven + targeted observers)
  // =========================================================================

  function clearTrackedVideoListeners() {
    for (const [video, handlers] of videoListenerRegistry.entries()) {
      try {
        video.removeEventListener("playing", handlers.onPlaying);
        video.removeEventListener("ended", handlers.onEnded);
      } catch {
        // Ignore DOM teardown errors.
      }
      if (video.classList) {
        video.classList.remove("omnifetch-active-video");
      }
      if (video.dataset?.omnifetchHandled) {
        delete video.dataset.omnifetchHandled;
      }
    }
    videoListenerRegistry.clear();
  }

  function pruneDetachedVideoListeners() {
    for (const [video, handlers] of videoListenerRegistry.entries()) {
      if (video.isConnected) {
        continue;
      }
      try {
        video.removeEventListener("playing", handlers.onPlaying);
        video.removeEventListener("ended", handlers.onEnded);
      } catch {
        // Ignore detached node cleanup errors.
      }
      videoListenerRegistry.delete(video);
    }
  }

  function handleVideo(video) {
    // Resolve custom elements to inner <video>
    if (video.tagName !== "VIDEO") {
      const inner =
        video.querySelector("video") ||
        video.shadowRoot?.querySelector("video");
      if (inner) {
        video = inner;
      } else {
        return;
      }
    }
    if (!video || video.tagName !== "VIDEO") {
      return;
    }
    if (videoListenerRegistry.has(video) || video.dataset.omnifetchHandled) {
      return;
    }
    video.dataset.omnifetchHandled = "true";

    const onPlaying = async () => {
      const src =
        (await extractDirectVideoSrc(video)) || getPreferredSniffRoute();
      if (!src) {
        return;
      }
      activeVideoSrc = src;
      if (isBlobUrl(src)) {
        syncActiveMSEState(src);
      }
      if (!isDirectVideoTab) {
        if (activeVideoElement && activeVideoElement !== video) {
          activeVideoElement.classList.remove("omnifetch-active-video");
        }
        activeVideoElement = video;
        video.classList.add("omnifetch-active-video");
      }
      updateDownloadLink(src);
    };

    const onEnded = async () => {
      if (video === activeVideoElement || !activeVideoElement) {
        const src =
          (await extractDirectVideoSrc(video)) || getPreferredSniffRoute();
        if (src) {
          activeVideoSrc = src;
          if (isBlobUrl(src)) {
            syncActiveMSEState(src);
          }
          updateDownloadLink(src);
        }
      }
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("ended", onEnded);
    videoListenerRegistry.set(video, { onEnded, onPlaying });

    // Passive pickup if nothing active yet
    if (!activeVideoSrc && (video.currentSrc || video.src)) {
      extractDirectVideoSrc(video).then((resolvedSrc) => {
        const src = resolvedSrc || getPreferredSniffRoute();
        if (src && !activeVideoSrc) {
          activeVideoSrc = src;
          activeVideoElement = video;
          if (isBlobUrl(src)) {
            syncActiveMSEState(src);
          }
          updateDownloadLink(src);
        }
      });
    }
  }

  function scanForFrameworkPlayers() {
    // Video.js
    if (uWindow.videojs) {
      try {
        const p = uWindow.videojs.getPlayers();
        Object.values(p).forEach((pl) => {
          if (pl?.tech_?.el_) {
            handleVideo(pl.tech_.el_);
          }
        });
      } catch {
        // Ignore framework adapter errors on unsupported pages.
      }
    }
    // JW Player
    if (uWindow.jwplayer) {
      try {
        const jw = uWindow.jwplayer();
        if (jw?.getContainer) {
          const v = jw.getContainer().querySelector("video");
          if (v) {
            handleVideo(v);
          }
        }
      } catch {
        // Ignore framework adapter errors on unsupported pages.
      }
    }
    // Plyr / Flowplayer
    document
      .querySelectorAll(
        ".plyr video, .plyr__video-wrapper video, .flowplayer video",
      )
      .forEach(handleVideo);
    // Same-origin iframes
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          doc.querySelectorAll("video").forEach(handleVideo);
        }
      } catch {
        /* cross-origin */
      }
    });
  }

  // =========================================================================
  // SECTION 13: SPA NAVIGATION & LIFECYCLE
  // =========================================================================

  let lastKnownUrl = window.location.href;
  let mutationObserver = null;
  let rescanInterval = null;
  let statusRefreshInterval = null;

  function resetState() {
    Log.info("Navigation reset");
    clearTrackedVideoListeners();
    activeVideoSrc = null;
    activeVideoElement = null;
    isDirectVideoTab = false;

    // Cancel in-flight downloads and abort requests
    if (currentDownloadId !== 0) {
      abortAllRequests();
      currentDownloadId = 0;
    }

    sniffedManifestUrls = [];
    sniffedManifestMeta.clear();
    approvedSniffHosts.clear();
    approvedThirdPartyHosts.clear();
    lastAutoMSESignature = "";

    try {
      const of = uWindow.__omnifetch;
      if (of) {
        if (typeof of.resetCaptureState === "function") {
          of.resetCaptureState();
        } else {
          of.videoChunks = [];
          of.audioChunks = [];
          of.videoChunkCount = 0;
          of.audioChunkCount = 0;
          of.videoMime = "";
          of.audioMime = "";
          of.videoStorageMode = "memory";
          of.audioStorageMode = "memory";
          of.captureLimitReached = false;
          of.captureStopReason = "";
          of.mseComplete = false;
          of.sniffedUrls = [];
          of.totalVideoBytes = 0;
          of.totalAudioBytes = 0;
          uWindow.video = of.videoChunks;
          uWindow.audio = of.audioChunks;
          uWindow.isComplete = 0;
        }
      }
    } catch {
      // Ignore reset errors when page-script state is unavailable.
    }
    uWindow.isComplete = 0;

    const badge = document.getElementById("omnifetch-sniff-badge");
    if (badge) {
      badge.textContent = "0";
      badge.style.display = "none";
    }
    if (buttonContainer) {
      buttonContainer.style.display = "none";
    }
    updateMSEStatusIndicator("");
    hideProgressOverlay();
  }

  function rescanPage() {
    stripIframeSandboxAttributes();
    createUI();
    if (document.contentType?.startsWith("video/")) {
      isDirectVideoTab = true;
      activeVideoSrc = window.location.href;
      updateDownloadLink(activeVideoSrc);
      return;
    }
    pruneDetachedVideoListeners();
    document.querySelectorAll("video, shreddit-player").forEach(handleVideo);
    scanForFrameworkPlayers();
    if (activeVideoSrc) {
      updateDownloadLink(activeVideoSrc);
      return;
    }
    updateMSEStatusIndicator("");
    const sniffRoute = getPreferredSniffRoute();
    if (sniffRoute) {
      updateDownloadLink(sniffRoute);
    }
  }

  function onNavigationDetected(newUrl) {
    const oldBase = lastKnownUrl.split("#")[0];
    const newBase = newUrl.split("#")[0];
    if (oldBase === newBase) {
      return;
    }
    lastKnownUrl = newUrl;
    resetState();
    setTimeout(rescanPage, 600);
    setTimeout(rescanPage, 1500);
  }

  // =========================================================================
  // SECTION 14: INITIALIZATION
  // =========================================================================

  function initializeEngine() {
    Log.info("Engine starting on", HOST);

    // Listen for SPA navigation events (from injected page script)
    window.addEventListener("omnifetch-navigation", (e) => {
      onNavigationDetected(e.detail?.url || window.location.href);
    });
    window.addEventListener("popstate", () =>
      onNavigationDetected(window.location.href),
    );

    // Initial scan
    rescanPage();

    // MutationObserver — targeted, only fires handleVideo for new video elements
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    mutationObserver = new MutationObserver((mutations) => {
      let hasNewVideos = false;
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
          }
          if (
            settings.removeIframeSandbox &&
            (node.tagName === "IFRAME" ||
              node.querySelector?.("iframe[sandbox]"))
          ) {
            stripIframeSandboxAttributes();
          }
          if (node.tagName === "VIDEO" || node.tagName === "SHREDDIT-PLAYER") {
            handleVideo(node);
            hasNewVideos = true;
          } else if (node.querySelectorAll) {
            const vids = node.querySelectorAll("video, shreddit-player");
            if (vids.length > 0) {
              vids.forEach(handleVideo);
              hasNewVideos = true;
            }
          }
        }
      }
      // Only scan frameworks if we found new DOM content with videos
      if (hasNewVideos) {
        scanForFrameworkPlayers();
      }
    });
    // Safari safety: document.body may rarely be null even after DOMContentLoaded
    const observeTarget = document.body || document.documentElement;
    mutationObserver.observe(observeTarget, { childList: true, subtree: true });

    // Periodic fallback (reduced frequency, exponential backoff idea: fixed interval is simpler for userscript)
    if (rescanInterval) {
      clearInterval(rescanInterval);
    }
    rescanInterval = setInterval(() => {
      pruneDetachedVideoListeners();
      if (settings.removeIframeSandbox) {
        stripIframeSandboxAttributes();
      }

      // URL polling fallback for SPAs that bypass history hooks
      if (window.location.href !== lastKnownUrl) {
        onNavigationDetected(window.location.href);
        return;
      }
      // Only scan unhandled videos (not a full querySelectorAll re-handle)
      document
        .querySelectorAll("video:not([data-omnifetch-handled])")
        .forEach(handleVideo);
      // Check sniffed URLs when no video element is active
      if (!activeVideoSrc && sniffedManifestUrls.length > 0) {
        const sniffRoute = getPreferredSniffRoute();
        if (sniffRoute) {
          updateDownloadLink(sniffRoute);
        }
      }

      if (activeVideoSrc && isBlobUrl(activeVideoSrc)) {
        updateMSEStatusIndicator(activeVideoSrc);
      }

      maybeAutoDownloadMSE("interval");
    }, settings.rescanIntervalMs);

    if (statusRefreshInterval) {
      clearInterval(statusRefreshInterval);
    }
    statusRefreshInterval = setInterval(() => {
      if (activeVideoSrc && isBlobUrl(activeVideoSrc)) {
        updateMSEStatusIndicator(activeVideoSrc);
      }
    }, 1000);
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    abortAllRequests();
    clearTrackedVideoListeners();
    while (ffmpegAssetObjectUrls.length > 0) {
      URL.revokeObjectURL(ffmpegAssetObjectUrls.pop());
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    if (rescanInterval) {
      clearInterval(rescanInterval);
    }
    if (statusRefreshInterval) {
      clearInterval(statusRefreshInterval);
    }
  });

  // Start (skip main engine on Telegram — it has its own UI)
  if (!isTelegramMode) {
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", initializeEngine);
    } else {
      initializeEngine();
    }
  }
})();
