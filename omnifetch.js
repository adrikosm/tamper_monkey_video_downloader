// ==UserScript==
// @name         OmniFetch
// @namespace    http://tampermonkey.net/
// @version      26.2
// @description  Universal video downloader with real HLS/DASH support, FFmpeg muxing, MSE interception, network sniffing, and per-site settings. Supports Reddit, Twitter/X, Facebook, Instagram, TikTok, Vimeo, Telegram, and any HTML5 video player.
// @author       adrikosm
// @match        *://*/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
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

  const HOST = window.location.hostname;
  const uWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  // =========================================================================
  // SECTION 0: SETTINGS & CONFIGURATION
  // =========================================================================

  const DEFAULT_SETTINGS = {
    enabled: true, // Master switch
    enabledSites: {}, // Per-host overrides: { "example.com": false }
    maxMSEMemoryMB: 6144, // Hard cap on MSE buffer capture (MB) — 6 GB
    hlsConcurrency: 4, // Parallel HLS segment downloads
    dashConcurrency: 4, // Parallel DASH segment downloads
    requestTimeoutText: 15000, // Timeout for text/json fetches (ms)
    requestTimeoutBlob: 60000, // Timeout for blob/binary fetches (ms)
    maxRetries: 2, // Retry count on network failure
    enableThirdPartyYT: false, // YouTube via external converter (opt-in)
    enableTelegram: true, // Telegram download module
    enableYouTube: true, // YouTube download routing
    enableTwitter: true, // Twitter/X video extraction
    enableReddit: true, // Reddit → RapidSave routing
    enableMSECapture: true, // MSE buffer interception
    enableNetworkSniff: true, // fetch/XHR hook for manifest detection
    logLevel: "info", // 'debug' | 'info' | 'warn' | 'error'
    rescanIntervalMs: 5000, // Fallback rescan interval
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  try {
    const saved = GM_getValue("omnifetch_settings", null);
    if (saved) Object.assign(settings, JSON.parse(saved));
  } catch (e) {
    /* use defaults */
  }

  function saveSettings() {
    try {
      GM_setValue("omnifetch_settings", JSON.stringify(settings));
    } catch (e) {}
  }

  function isSiteEnabled() {
    if (!settings.enabled) return false;
    if (settings.enabledSites.hasOwnProperty(HOST))
      return settings.enabledSites[HOST];
    return true; // enabled by default unless explicitly disabled
  }

  // =========================================================================
  // SECTION 1: STRUCTURED LOGGER WITH RING BUFFER
  // =========================================================================

  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
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
      if (logRing.length > LOG_RING_SIZE) logRing.shift();
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
        `OmniFetch v24.2 Debug Report — ${new Date().toISOString()}`,
        `URL: ${window.location.href}`,
        `UA: ${navigator.userAgent}`,
        `Settings: ${JSON.stringify(settings, null, 2)}`,
        `Active source: ${activeVideoSrc || "none"}`,
        `Sniffed URLs: ${JSON.stringify(sniffedManifestUrls)}`,
        `MSE state: video=${uWindow.__omnifetch?.videoChunks?.length || 0} chunks, audio=${uWindow.__omnifetch?.audioChunks?.length || 0} chunks, complete=${uWindow.__omnifetch?.mseComplete}`,
        `------- LOG (last ${logRing.length} entries) -------`,
        ...logRing.map((e) => `[${e.ts}][${e.level}] ${e.msg}`),
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
      for (let i = 0; i < s.length; i++)
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return h >>> 0;
    };

    const createProgressBar = (videoId, fileName) => {
      const isDarkMode =
        document.querySelector("html")?.classList.contains("night") ||
        document.querySelector("html")?.classList.contains("theme-dark");
      const container = document.getElementById(
        "tel-downloader-progress-bar-container",
      );
      if (!container) return;
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
      if (!el) return;
      el.querySelector("p.filename").textContent = fileName;
      const bar = el.querySelector("div.progress");
      bar.querySelector("p").textContent = pct + "%";
      bar.querySelector("div").style.width = pct + "%";
    };
    const completeProgress = (videoId) => {
      const bar = document
        .getElementById("tel-downloader-progress-" + videoId)
        ?.querySelector("div.progress");
      if (!bar) return;
      bar.querySelector("p").textContent = "Completed";
      bar.querySelector("div").style.cssText +=
        ";background:#B6C649;width:100%";
    };
    const abortProgress = (videoId) => {
      const bar = document
        .getElementById("tel-downloader-progress-" + videoId)
        ?.querySelector("div.progress");
      if (!bar) return;
      bar.querySelector("p").textContent = "Aborted";
      bar.querySelector("div").style.cssText +=
        ";background:#D16666;width:100%";
    };

    const tel_download_video = (url) => {
      // If the URL is a blob: (MediaSource/MSE stream), we can't range-request it.
      // Use MSE-captured chunks which contain the full muxed audio+video data.
      if (url && url.startsWith("blob:")) {
        return tel_download_mse_video();
      }
      // Direct URL: download via range requests
      const blobs = [];
      let nextOffset = 0,
        totalSize = null,
        ext = "mp4";
      const videoId =
        Math.random().toString(36).slice(2, 10) + "_" + Date.now();
      let fileName = hashCode(url).toString(36) + "." + ext;
      try {
        const meta = JSON.parse(decodeURIComponent(url.split("/").pop()));
        if (meta.fileName) fileName = meta.fileName;
      } catch (e) {}
      const fetchPart = (writable) => {
        fetch(url, {
          method: "GET",
          headers: { Range: `bytes=${nextOffset}-` },
        })
          .then((res) => {
            if (![200, 206].includes(res.status))
              throw new Error("HTTP " + res.status);
            const mime = (res.headers.get("Content-Type") || "video/mp4").split(
              ";",
            )[0];
            if (mime.startsWith("video/")) {
              ext = mime.split("/")[1];
              fileName = fileName.replace(/\.[^.]+$/, "." + ext);
            }
            const range = (res.headers.get("Content-Range") || "").match(
              contentRangeRegex,
            );
            if (range) {
              if (parseInt(range[1]) !== nextOffset)
                throw new Error("Gap detected");
              nextOffset = parseInt(range[2]) + 1;
              totalSize = parseInt(range[3]);
              updateProgress(
                videoId,
                fileName,
                ((nextOffset * 100) / totalSize).toFixed(0),
              );
            }
            return res.blob();
          })
          .then((blob) => (writable ? writable.write(blob) : blobs.push(blob)))
          .then(() => {
            if (totalSize && nextOffset < totalSize) fetchPart(writable);
            else {
              if (writable) writable.close();
              else {
                const blobUrl = URL.createObjectURL(
                  new Blob(blobs, { type: "video/mp4" }),
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
    const tel_download_mse_video = async () => {
      const of = uWindow.__omnifetch;
      if (!of) {
        alert(
          "Video capture not ready.\nPlease wait for the video to load and try again.",
        );
        return;
      }

      const vChunks = of.videoChunks || [];
      const aChunks = of.audioChunks || [];

      if (vChunks.length === 0 && aChunks.length === 0) {
        alert(
          "No video data captured yet.\n\nPlease let the video play to the end, then click download again.",
        );
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
        )
          return;
      }

      const videoId =
        Math.random().toString(36).slice(2, 10) + "_" + Date.now();
      const fileName = "telegram_video_" + Date.now() + ".mp4";
      createProgressBar(videoId, fileName);
      updateProgress(videoId, fileName, 50);

      try {
        if (aChunks.length > 0 && vChunks.length > 0) {
          // Separate audio + video SourceBuffers — need to mux with FFmpeg
          // muxVideoAudio() is a function declaration (hoisted) and all its dependencies
          // are initialized by click-time because we no longer return early.
          updateProgress(videoId, fileName, 60);
          const videoBlob = new Blob(vChunks, {
            type: of.videoMime || "video/mp4",
          });
          const audioBlob = new Blob(aChunks, {
            type: of.audioMime || "audio/mp4",
          });
          const muxed = await muxVideoAudio(videoBlob, audioBlob);
          updateProgress(videoId, fileName, 90);
          if (muxed) {
            triggerBlobDownload(muxed, fileName);
          } else {
            Log.warn("Telegram mux failed, downloading tracks separately");
            triggerBlobDownload(videoBlob, "telegram_video.mp4");
            setTimeout(
              () => triggerBlobDownload(audioBlob, "telegram_audio.m4a"),
              500,
            );
          }
        } else {
          // Single muxed track (typical: Telegram feeds interleaved MP4 to one SourceBuffer)
          const chunks = vChunks.length > 0 ? vChunks : aChunks;
          const blob = new Blob(chunks, { type: "video/mp4" });
          triggerBlobDownload(blob, fileName);
        }
        completeProgress(videoId);
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
    setInterval(() => {
      const actions = document.querySelector(
        "#MediaViewer .MediaViewerActions",
      );
      if (!actions) return;
      const vid = document.querySelector(
        "#MediaViewer .MediaViewerContent > .VideoPlayer",
      );
      const img = document.querySelector(
        "#MediaViewer .MediaViewerContent > div > img",
      );
      if (vid && !actions.querySelector("button.tel-download")) {
        const btn = document.createElement("button");
        btn.className = "Button smaller translucent-white round tel-download";
        btn.title = "Download";
        btn.innerHTML = '<i class="icon icon-download"></i>';
        btn.onclick = () =>
          tel_download_video(vid.querySelector("video")?.currentSrc);
        actions.prepend(btn);
      } else if (img?.src && !actions.querySelector("button.tel-download")) {
        const btn = document.createElement("button");
        btn.className = "Button smaller translucent-white round tel-download";
        btn.title = "Download";
        btn.innerHTML = '<i class="icon icon-download"></i>';
        btn.onclick = () => tel_download_image(img.src);
        actions.prepend(btn);
      }
    }, REFRESH_DELAY);

    setInterval(() => {
      const aspecter = document.querySelector(
        ".media-viewer-whole .media-viewer-movers .media-viewer-aspecter",
      );
      const buttons = document.querySelector(
        ".media-viewer-whole .media-viewer-topbar .media-viewer-buttons",
      );
      if (!aspecter || !buttons) return;
      buttons.querySelectorAll("button.btn-icon.hide").forEach((b) => {
        b.classList.remove("hide");
        if (b.textContent === DOWNLOAD_ICON) b.classList.add("tgico-download");
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

  Log.info("OmniFetch v24 initializing on", HOST);

  // =========================================================================
  // SECTION 2: NETWORKING PRIMITIVES (timeout + retry + abort)
  // =========================================================================

  // Track all active GM request handles so we can abort on cancel/navigation
  const activeRequests = new Set();

  function abortAllRequests() {
    for (const handle of activeRequests) {
      try {
        if (typeof handle.abort === "function") handle.abort();
      } catch (e) {}
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
            if (handle) activeRequests.delete(handle);
            resolve(r);
          },
          onerror(e) {
            if (handle) activeRequests.delete(handle);
            reject(
              new Error(
                "Network error: " + (e?.statusText || e?.error || "unknown"),
              ),
            );
          },
          ontimeout() {
            if (handle) activeRequests.delete(handle);
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
      if (handle && typeof handle.abort === "function")
        activeRequests.add(handle);
    });
  }

  async function fetchText(url, retries) {
    retries = retries ?? settings.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await gmRequest({
          method: "GET",
          url,
          headers: { Accept: "*/*" },
          timeout: settings.requestTimeoutText,
        });
        if (r.status >= 200 && r.status < 400) return r.responseText;
        throw new Error("HTTP " + r.status);
      } catch (e) {
        if (attempt === retries) throw e;
        Log.debug(
          `fetchText retry ${attempt + 1}/${retries} for ${url.substring(0, 80)}: ${e.message}`,
        );
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // backoff
      }
    }
  }

  async function fetchJSON(url, headers = {}, method = "GET") {
    const r = await gmRequest({
      method,
      url,
      headers,
      timeout: settings.requestTimeoutText,
    });
    // Handle TM implementation differences: r.response may already be parsed
    if (typeof r.response === "object" && r.response !== null)
      return r.response;
    return JSON.parse(r.responseText);
  }

  async function fetchBlob(url, onProgress = null, retries) {
    retries = retries ?? settings.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await gmRequest({
          method: "GET",
          url,
          responseType: "blob",
          headers: { Accept: "*/*", Referer: window.location.href },
          timeout: settings.requestTimeoutBlob,
          onprogress: onProgress
            ? (p) => {
                if (p.lengthComputable) onProgress(p.loaded, p.total);
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
          } catch (_) {
            blob = null;
          }
        }
        if (blob && blob.size > 0) return blob;
        // Last resort: if responseType was silently ignored, raw text may exist
        if (r.responseText && r.responseText.length > 0) {
          const enc = new TextEncoder();
          return new Blob([enc.encode(r.responseText)]);
        }
        throw new Error("Empty response");
      } catch (e) {
        if (attempt === retries) throw e;
        Log.debug(`fetchBlob retry ${attempt + 1}/${retries}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
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
      }, 30000);
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
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
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
          if (onEachDone) onEachDone(completed, urls.length);
        } catch (e) {
          if (!firstError) firstError = e;
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++)
      workers.push(worker());
    await Promise.all(workers);
    if (firstError) throw firstError;
    return results;
  }

  // =========================================================================
  // SECTION 3: MSE INTERCEPTOR + NETWORK SNIFFER (page-context injection)
  // =========================================================================

  function injectPageScript() {
    const code = `(function(){
            if(window.__omnifetchInjected) return;
            window.__omnifetchInjected = true;

            var OF = window.__omnifetch = window.__omnifetch || {};
            OF.videoChunks = []; OF.audioChunks = [];
            OF.videoMime = ''; OF.audioMime = '';
            OF.mseComplete = false; OF.sniffedUrls = [];
            OF.totalVideoBytes = 0; OF.totalAudioBytes = 0;
            OF.maxBytes = ${settings.maxMSEMemoryMB * 1024 * 1024};
            OF.captureEnabled = ${settings.enableMSECapture};
            OF.sniffEnabled = ${settings.enableNetworkSniff};

            // --- MSE Interceptor with memory cap ---
            // Hooks both MediaSource (Chrome/Firefox/old Safari) and
            // ManagedMediaSource (Safari 17+) for full WebKit coverage.
            function hookMSEProto(MSE, label) {
                if (!MSE || !MSE.prototype || !MSE.prototype.addSourceBuffer) return;
                try {
                    var _addSB = MSE.prototype.addSourceBuffer;
                    MSE.prototype.addSourceBuffer = function(mime) {
                        var mimeStr = String(mime);
                        var isVideo = mimeStr.includes('video');
                        var isAudio = mimeStr.includes('audio');
                        if (isVideo) { OF.videoChunks = []; OF.videoMime = mimeStr; OF.totalVideoBytes = 0; }
                        if (isAudio) { OF.audioChunks = []; OF.audioMime = mimeStr; OF.totalAudioBytes = 0; }
                        var sb = _addSB.call(this, mime);
                        if (sb && sb.appendBuffer) {
                            var _append = sb.appendBuffer;
                            sb.appendBuffer = function(buffer) {
                                try {
                                    var bytes;
                                    if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
                                    else if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                                    else bytes = new Uint8Array(buffer);
                                    var totalNow = OF.totalVideoBytes + OF.totalAudioBytes + bytes.byteLength;
                                    if (totalNow <= OF.maxBytes) {
                                        var copy = new Uint8Array(bytes.byteLength);
                                        copy.set(bytes);
                                        if (isVideo) { OF.videoChunks.push(copy.buffer); OF.totalVideoBytes += bytes.byteLength; }
                                        if (isAudio) { OF.audioChunks.push(copy.buffer); OF.totalAudioBytes += bytes.byteLength; }
                                    }
                                } catch(e) {}
                                return _append.call(this, buffer);
                            };
                        }
                        return sb;
                    };
                    var _eos = MSE.prototype.endOfStream;
                    MSE.prototype.endOfStream = function() {
                        OF.mseComplete = true;
                        try { window.dispatchEvent(new CustomEvent('omnifetch-mse-complete')); } catch(e) {}
                        return _eos.apply(this, arguments);
                    };
                } catch(e) { /* prototype frozen or inaccessible */ }
            }
            if (OF.captureEnabled) {
                hookMSEProto(window.MediaSource, 'MediaSource');
                hookMSEProto(window.ManagedMediaSource, 'ManagedMediaSource'); // Safari 17+
                hookMSEProto(window.WebKitMediaSource, 'WebKitMediaSource');   // Legacy Safari
            }

            // --- Network Sniffer ---
            if (OF.sniffEnabled) {
                var pushUrl = function(url) {
                    if (typeof url !== 'string') return;
                    if (url.includes('.m3u8') || url.includes('.mpd')) {
                        if (OF.sniffedUrls.indexOf(url) === -1) {
                            OF.sniffedUrls.push(url);
                            try { window.dispatchEvent(new CustomEvent('omnifetch-url-sniffed', { detail: { url: url } })); } catch(e) {}
                        }
                    }
                };
                if (window.fetch) {
                    var _fetch = window.fetch;
                    window.fetch = function(input) {
                        try {
                            var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
                            pushUrl(url);
                        } catch(e) {}
                        return _fetch.apply(this, arguments);
                    };
                }
                if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
                    var _xhrOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url) {
                        try { pushUrl(url); } catch(e) {}
                        return _xhrOpen.apply(this, arguments);
                    };
                }
            }

            // --- History API hooks for SPA detection ---
            if (!window.__omnifetchHistoryHooked && window.history) {
                window.__omnifetchHistoryHooked = true;
                try {
                    var _push = history.pushState, _replace = history.replaceState;
                    if (_push) {
                        history.pushState = function() {
                            var r = _push.apply(this, arguments);
                            try { window.dispatchEvent(new CustomEvent('omnifetch-navigation', { detail: { type: 'pushState', url: location.href } })); } catch(e) {}
                            return r;
                        };
                    }
                    if (_replace) {
                        history.replaceState = function() {
                            var r = _replace.apply(this, arguments);
                            try { window.dispatchEvent(new CustomEvent('omnifetch-navigation', { detail: { type: 'replaceState', url: location.href } })); } catch(e) {}
                            return r;
                        };
                    }
                } catch(e) {}
            }
        })();`;

    // CSP-safe injection: try script tag first, fall back to eval via unsafeWindow
    try {
      const s = document.createElement("script");
      s.textContent = code;
      (document.documentElement || document.head || document.body).appendChild(
        s,
      );
      s.remove();
    } catch (e) {
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

  let ffmpegInstance = null;
  let ffmpegLoading = false;
  let ffmpegReady = false;

  async function loadFFmpeg() {
    if (ffmpegReady) return true;
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
        Log.info("Loading FFmpeg.wasm from CDN...");
        await withTimeout(
          new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src =
              "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.min.js";
            s.onload = resolve;
            s.onerror = () =>
              reject(new Error("FFmpeg script load failed (network or CSP)"));
            (document.head || document.documentElement).appendChild(s);
          }),
          25000,
          "FFmpeg script load",
        );
        lib = window.FFmpegWASM || window.FFmpeg;
      }
      if (lib?.FFmpeg) {
        ffmpegInstance = new lib.FFmpeg();
        // Always use the single-threaded UMD core — it works in Safari
        // and every other browser without needing COOP/COEP headers.
        const base =
          "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd";
        const loadOpts = {
          coreURL: `${base}/ffmpeg-core.js`,
          wasmURL: `${base}/ffmpeg-core.wasm`,
        };
        await withTimeout(
          ffmpegInstance.load(loadOpts),
          40000,
          "FFmpeg WASM load",
        );
        ffmpegReady = true;
        Log.info("FFmpeg.wasm ready (single-threaded UMD core).");
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

  async function muxVideoAudio(videoBlob, audioBlob) {
    if (!(await loadFFmpeg()) || !ffmpegInstance) return null;
    try {
      showProgressOverlay("Muxing audio + video...");
      const vData = new Uint8Array(await videoBlob.arrayBuffer());
      const aData = new Uint8Array(await audioBlob.arrayBuffer());
      await ffmpegInstance.writeFile("iv.mp4", vData);
      await ffmpegInstance.writeFile("ia.mp4", aData);
      await withTimeout(
        ffmpegInstance.exec([
          "-fflags",
          "+genpts+igndts",
          "-i",
          "iv.mp4",
          "-fflags",
          "+genpts+igndts",
          "-i",
          "ia.mp4",
          "-c:v",
          "copy",
          "-c:a",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-start_at_zero",
          "-movflags",
          "+faststart",
          "o.mp4",
        ]),
        90000,
        "FFmpeg mux",
      );
      const out = await ffmpegInstance.readFile("o.mp4");
      const result = new Blob([out.buffer], { type: "video/mp4" });
      for (const f of ["iv.mp4", "ia.mp4", "o.mp4"]) {
        try {
          await ffmpegInstance.deleteFile(f);
        } catch (e) {}
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
    if (!(await loadFFmpeg()) || !ffmpegInstance) return null;
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
        } catch (e) {}
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
    let currentByteOffset = 0;

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
            bandwidth: bw ? parseInt(bw[1]) : 0,
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
        if (!isNaN(dur)) currentDuration = dur;
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
        } catch (e) {
          /* skip malformed URLs */
        }
      }
    }

    return result;
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

    if (master.isMaster) {
      // Pick best variant
      const sorted = master.variants
        .slice()
        .sort((a, b) => b.bandwidth - a.bandwidth);
      if (sorted.length === 0)
        throw new Error("No variants found in master playlist");
      videoPlaylistUrl = sorted[0].url;
      Log.info(
        `HLS: picked variant ${sorted[0].resolution || "best"} (${sorted[0].bandwidth} bps)`,
      );

      // Check for separate audio rendition
      if (sorted[0].audioGroupId && master.audioRenditions.length > 0) {
        const audioRend = master.audioRenditions.find(
          (r) => r.groupId === sorted[0].audioGroupId,
        );
        if (audioRend) audioPlaylistUrl = audioRend.url;
      }
    }

    // Download video segments
    const videoBlob = await downloadHLSPlaylist(
      videoPlaylistUrl,
      btn,
      dlId,
      "V",
    );
    if (isStale(dlId) || !videoBlob) return;

    let finalBlob = videoBlob;
    let alreadyMuxed = false;

    // Download audio segments if separate
    if (audioPlaylistUrl) {
      Log.info("HLS: downloading separate audio rendition");
      setBtnProgress(btn, "Audio...");
      const audioBlob = await downloadHLSPlaylist(
        audioPlaylistUrl,
        btn,
        dlId,
        "A",
      );
      if (isStale(dlId)) return;
      if (audioBlob) {
        const muxed = await muxVideoAudio(videoBlob, audioBlob);
        if (muxed) {
          finalBlob = muxed;
          alreadyMuxed = true;
        } else {
          triggerBlobDownload(videoBlob, "video_track.mp4");
          setTimeout(
            () => triggerBlobDownload(audioBlob, "audio_track.m4a"),
            500,
          );
          return;
        }
      }
    }

    // Always remux concatenated segments to fix timestamp gaps / blank frames,
    // unless muxVideoAudio already ran (which applies the same timestamp fixes).
    if (!alreadyMuxed && !isStale(dlId)) {
      setBtnProgress(btn, "Remux...");
      const ext = videoBlob.type === "video/mp4" ? "mp4" : "ts";
      const remuxed = await remuxToMP4(finalBlob, ext);
      if (remuxed) finalBlob = remuxed;
    }

    if (!isStale(dlId)) {
      const ext = finalBlob.type === "video/mp4" ? ".mp4" : ".ts";
      triggerBlobDownload(finalBlob, "video_download" + ext);
    }
  }

  async function downloadHLSPlaylist(playlistUrl, btn, dlId, label) {
    const text = await fetchText(playlistUrl);
    const playlist = parseM3U8(text, playlistUrl);

    if (playlist.isEncrypted) throw new Error("Encrypted HLS stream");
    if (playlist.segments.length === 0)
      throw new Error("No segments in playlist");

    const urls = [];
    // fMP4: init segment must come first
    if (playlist.initSegment) {
      urls.push(playlist.initSegment.url);
    }
    playlist.segments.forEach((s) => urls.push(s.url));

    Log.info(
      `HLS[${label}]: ${urls.length} segments, ~${playlist.totalDuration.toFixed(0)}s, fMP4=${playlist.isFMP4}`,
    );

    const blobs = await downloadParallel(
      urls,
      settings.hlsConcurrency,
      (done, total) => {
        if (!isStale(dlId)) setBtnProgress(btn, `${label} ${done}/${total}`);
      },
    );

    if (isStale(dlId)) return null;

    const type = playlist.isFMP4 ? "video/mp4" : "video/mp2t";
    return new Blob(blobs, { type });
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
          bandwidth: parseInt(rep.getAttribute("bandwidth") || "0"),
          width: parseInt(rep.getAttribute("width") || "0"),
          height: parseInt(rep.getAttribute("height") || "0"),
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
          );
          const timescale = parseInt(segTpl.getAttribute("timescale") || "1");
          const duration = parseInt(segTpl.getAttribute("duration") || "0");

          const repId = entry.id;
          const repBw = entry.bandwidth;

          const fillTemplate = (tpl, num, time) => {
            return tpl
              .replace(/\$RepresentationID\$/g, repId)
              .replace(/\$Bandwidth\$/g, String(repBw))
              .replace(/\$Number(%\d+d)?\$/g, (_, fmt) =>
                fmt
                  ? String(num).padStart(parseInt(fmt.slice(1)), "0")
                  : String(num),
              )
              .replace(/\$Time\$/g, String(time));
          };

          const segs = [];

          // Init segment
          if (init)
            segs.push(new URL(fillTemplate(init, startNumber, 0), mpdUrl).href);

          // Check for SegmentTimeline
          const timeline = segTpl.querySelector("SegmentTimeline");
          if (timeline) {
            const entries = timeline.querySelectorAll("S");
            let time = 0,
              num = startNumber;
            entries.forEach((s) => {
              const t = s.getAttribute("t")
                ? parseInt(s.getAttribute("t"))
                : time;
              const d = parseInt(s.getAttribute("d") || "0");
              const r = parseInt(s.getAttribute("r") || "0");
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
              if (m)
                periodDurSec =
                  parseInt(m[1] || 0) * 3600 +
                  parseInt(m[2] || 0) * 60 +
                  parseFloat(m[3] || 0);
            }
            const segDurSec = duration / timescale;
            const segCount = Math.ceil(periodDurSec / segDurSec);
            for (let n = startNumber; n < startNumber + segCount; n++) {
              segs.push(new URL(fillTemplate(media, n, 0), mpdUrl).href);
            }
          }

          if (segs.length > 0) entry.segments = segs;
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
            if (mediaUrl) segs.push(new URL(mediaUrl, mpdUrl).href);
          });
          if (segs.length > 0) entry.segments = segs;
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
    if (isStale(dlId)) return;

    const mpd = parseMPD(xmlText, mpdUrl);
    if (mpd.video.length === 0)
      throw new Error("No video representations found in MPD");

    const bestVideo = mpd.video[0];
    const bestAudio = mpd.audio.length > 0 ? mpd.audio[0] : null;

    Log.info(
      `DASH: video=${bestVideo.width}x${bestVideo.height} (${bestVideo.segments.length} segs), audio=${bestAudio ? bestAudio.segments.length + " segs" : "none"}`,
    );

    // Download video segments
    setBtnProgress(btn, "V 0%");
    let videoBlobs;
    if (bestVideo.segments.length === 1) {
      // Single file — direct download
      const blob = await fetchBlob(bestVideo.segments[0], (loaded, total) => {
        if (!isStale(dlId) && total)
          setBtnProgress(btn, "V " + Math.round((loaded / total) * 100) + "%");
      });
      videoBlobs = [blob];
    } else {
      videoBlobs = await downloadParallel(
        bestVideo.segments,
        settings.dashConcurrency,
        (done, total) => {
          if (!isStale(dlId)) setBtnProgress(btn, `V ${done}/${total}`);
        },
      );
    }
    if (isStale(dlId)) return;
    const videoBlob = new Blob(videoBlobs, { type: "video/mp4" });

    // Download audio segments
    if (bestAudio) {
      setBtnProgress(btn, "A 0%");
      let audioBlobs;
      if (bestAudio.segments.length === 1) {
        const blob = await fetchBlob(bestAudio.segments[0]);
        audioBlobs = [blob];
      } else {
        audioBlobs = await downloadParallel(
          bestAudio.segments,
          settings.dashConcurrency,
          (done, total) => {
            if (!isStale(dlId)) setBtnProgress(btn, `A ${done}/${total}`);
          },
        );
      }
      if (isStale(dlId)) return;
      const audioBlob = new Blob(audioBlobs, { type: "audio/mp4" });

      // Mux
      btn.innerHTML = svgMux;
      const muxed = await muxVideoAudio(videoBlob, audioBlob);
      if (muxed) {
        triggerBlobDownload(muxed, "video_download.mp4");
      } else {
        triggerBlobDownload(videoBlob, "video_track.mp4");
        setTimeout(
          () => triggerBlobDownload(audioBlob, "audio_track.m4a"),
          500,
        );
      }
    } else {
      // Video-only: remux to fix timestamp gaps in concatenated segments
      if (bestVideo.segments.length > 1) {
        setBtnProgress(btn, "Remux...");
        const remuxed = await remuxToMP4(videoBlob, "mp4");
        if (remuxed) {
          triggerBlobDownload(remuxed, "video_download.mp4");
        } else {
          triggerBlobDownload(videoBlob, "video_download.mp4");
        }
      } else {
        triggerBlobDownload(videoBlob, "video_download.mp4");
      }
    }
  }

  // =========================================================================
  // SECTION 7: REACT FIBER & SITE-SPECIFIC EXTRACTORS
  // =========================================================================

  const ReactUtils = {
    getFiber(el) {
      if (!el) return null;
      for (const p of Object.keys(el))
        if (
          p.startsWith("__reactFiber") ||
          p.startsWith("__reactInternalInstance")
        )
          return el[p];
      return null;
    },
    returnUntil(fiber, pred) {
      let f = fiber;
      while (f) {
        if (pred(f)) return f;
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
          if (impl) return impl.data.hdSrc || impl.data.sdSrc;
        }
      }
      // Twitter / X
      if (
        (HOST.includes("twitter.com") || HOST.includes("x.com")) &&
        settings.enableTwitter
      ) {
        if (video.dataset.twResolvedUrl) return video.dataset.twResolvedUrl;
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
        const post = video.closest("shreddit-post") || video.closest(".thing");
        let permalink = window.location.pathname;
        if (post?.getAttribute("permalink"))
          permalink = post.getAttribute("permalink");
        else if (post?.dataset?.permalink) permalink = post.dataset.permalink;
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
        if (t) return t.memoizedProps.videoUrl || t.memoizedProps.src;
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
        if (t)
          return (
            t.memoizedProps.videoData.downloadAddr ||
            t.memoizedProps.videoData.playAddr
          );
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
              if (progs[0]?.url) return progs[0].url;
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
        if (video.getAttribute(attr)) return video.getAttribute(attr);
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
        if (src) return src;
      }
      // Sniffed manifests (prefer m3u8 over mpd)
      if (sniffedManifestUrls.length > 0) {
        return (
          sniffedManifestUrls.find((u) => u.includes(".m3u8")) ||
          sniffedManifestUrls.find((u) => u.includes(".mpd")) ||
          null
        );
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
  let sniffedManifestUrls = [];

  function startDownload() {
    // Cancel any previous in-flight download
    if (currentDownloadId !== 0) abortAllRequests();
    currentDownloadId = Date.now() + Math.random();
    return currentDownloadId;
  }
  function isStale(dlId) {
    return currentDownloadId !== dlId;
  }
  function finishDownload(dlId) {
    if (currentDownloadId === dlId) currentDownloadId = 0;
  }
  function isIdle() {
    return currentDownloadId === 0;
  }

  function cancelCurrentDownload() {
    if (currentDownloadId === 0) return;
    Log.info("Download cancelled by user");
    abortAllRequests();
    currentDownloadId = 0;
    hideProgressOverlay();
    const btn = document.getElementById("omnifetch-dl-btn");
    if (btn) resetBtn(btn);
  }

  window.addEventListener("omnifetch-url-sniffed", (e) => {
    if (e.detail?.url && !sniffedManifestUrls.includes(e.detail.url)) {
      sniffedManifestUrls.push(e.detail.url);
      Log.debug("Sniffed manifest:", e.detail.url);
    }
  });

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
    if (!btn) return;
    btn.innerHTML = `<span style="font-size:11px;font-weight:700;color:#007AFF;font-family:system-ui;white-space:nowrap">${text}</span>`;
    btn.style.cursor = "wait";
    // Show cancel button
    const cancelBtn = document.getElementById("omnifetch-cancel-btn");
    if (cancelBtn) cancelBtn.style.display = "flex";
  }

  function resetBtn(btn) {
    if (!btn) return;
    btn.innerHTML = svgDownload;
    btn.style.backgroundColor = "rgba(255,255,255,0.9)";
    btn.style.cursor = "pointer";
    const cancelBtn = document.getElementById("omnifetch-cancel-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
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
    if (ov) ov.style.display = "none";
  }

  function createUI() {
    if (document.getElementById("omnifetch-container"))
      return document.getElementById("omnifetch-dl-btn");
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

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center";
    row.append(cancelBtn, settingsBtn);

    buttonContainer.append(btnWrap, row);
    document.body.appendChild(buttonContainer);

    createSettingsPanel();

    return btn;
  }

  function createSettingsPanel() {
    if (document.getElementById("omnifetch-settings-panel")) return;
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
            <label>MSE buffer capture <input type="checkbox" id="of-mse" ${settings.enableMSECapture ? "checked" : ""}></label>
            <label>Network sniffing <input type="checkbox" id="of-sniff" ${settings.enableNetworkSniff ? "checked" : ""}></label>
            <label>YouTube 3rd-party converter <input type="checkbox" id="of-yt3p" ${settings.enableThirdPartyYT ? "checked" : ""}></label>
            <hr>
            <label>MSE memory cap (MB) <input type="number" id="of-mse-cap" value="${settings.maxMSEMemoryMB}" min="64" max="8192"></label>
            <label>HLS concurrency <input type="number" id="of-hls-conc" value="${settings.hlsConcurrency}" min="1" max="8"></label>
            <label>Request timeout (s) <input type="number" id="of-timeout" value="${settings.requestTimeoutBlob / 1000}" min="5" max="300"></label>
            <label>Max retries <input type="number" id="of-retries" value="${settings.maxRetries}" min="0" max="5"></label>
            <hr>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="omnifetch-settings-btn" id="of-save-btn">Save &amp; Reload</button>
                <button class="omnifetch-settings-btn" id="of-debug-btn" style="background:#555">Copy Debug Report</button>
            </div>
            <p style="color:#666;font-size:10px;margin:8px 0 0">v24.2 · Changes apply after page reload</p>
        `;
    document.body.appendChild(panel);

    document.getElementById("of-save-btn").onclick = () => {
      const siteCheck = document.getElementById("of-site-enabled").checked;
      settings.enabledSites[HOST] = siteCheck;
      settings.enableTelegram = document.getElementById("of-tg").checked;
      settings.enableYouTube = document.getElementById("of-yt").checked;
      settings.enableTwitter = document.getElementById("of-tw").checked;
      settings.enableReddit = document.getElementById("of-rd").checked;
      settings.enableMSECapture = document.getElementById("of-mse").checked;
      settings.enableNetworkSniff = document.getElementById("of-sniff").checked;
      settings.enableThirdPartyYT = document.getElementById("of-yt3p").checked;
      settings.maxMSEMemoryMB =
        parseInt(document.getElementById("of-mse-cap").value) || 6144;
      settings.hlsConcurrency =
        parseInt(document.getElementById("of-hls-conc").value) || 4;
      settings.requestTimeoutBlob =
        (parseInt(document.getElementById("of-timeout").value) || 60) * 1000;
      settings.maxRetries =
        parseInt(document.getElementById("of-retries").value) || 2;
      saveSettings();
      window.location.reload();
    };

    document.getElementById("of-debug-btn").onclick = () => {
      const report = Log.exportReport();
      navigator.clipboard
        .writeText(report)
        .then(() => alert("Debug report copied to clipboard!"))
        .catch(() => {
          // Fallback
          const ta = document.createElement("textarea");
          ta.value = report;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          alert("Debug report copied!");
        });
    };
  }

  function toggleSettingsPanel() {
    const panel = document.getElementById("omnifetch-settings-panel");
    if (panel)
      panel.style.display = panel.style.display === "none" ? "block" : "none";
  }

  // =========================================================================
  // SECTION 10: DOWNLOAD ROUTERS (all use download-ID lock + try/finally)
  // =========================================================================

  async function triggerYT3PDownload(url, btn) {
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
        if (tab) tab.close();
        return;
      }
      const js = JSON.parse(resp.responseText);
      const fd2 = new FormData();
      fd2.set("vid", js.vid);
      const k = js.links?.mp4?.auto
        ? js.links.mp4.auto.k
        : Object.values(js.links?.mp4 || {})[0]?.k;
      if (!k) throw new Error("No conversion key found");
      fd2.set("k", k);
      btn.innerHTML = svgSettings;
      const res2 = await gmRequest({
        method: "POST",
        url: "https://yt1s.com/api/ajaxConvert/convert",
        data: fd2,
        timeout: 60000,
      });
      if (isStale(dlId)) {
        if (tab) tab.close();
        return;
      }
      const js2 = JSON.parse(res2.responseText);
      if (js2.c_status === "CONVERTED" && js2.dlink) {
        if (tab) tab.location.href = js2.dlink;
        else window.open(js2.dlink, "_blank");
      } else {
        if (tab) tab.close();
        alert(
          "YouTube conversion failed. Try a different video or disable 3rd-party in settings.",
        );
      }
    } catch (e) {
      if (tab) tab.close();
      if (!isStale(dlId)) Log.error("YT3P download:", e.message);
    } finally {
      if (!isStale(dlId)) resetBtn(btn);
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
      if (!isStale(dlId)) resetBtn(btn);
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
      if (!isStale(dlId)) resetBtn(btn);
      finishDownload(dlId);
    }
  }

  async function triggerNativeDownload(url, btn) {
    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    const filename = (() => {
      const path = url.split("?")[0].split("/").pop();
      return path.match(/\.[a-zA-Z0-9]{2,5}$/) ? path : "video_download.mp4";
    })();
    try {
      if (typeof GM_download === "function") {
        await new Promise((resolve, reject) => {
          GM_download({
            url,
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
        const blob = await fetchBlob(url, (loaded, total) => {
          if (!isStale(dlId) && total)
            setBtnProgress(btn, Math.round((loaded / total) * 100) + "%");
        });
        if (!isStale(dlId)) triggerBlobDownload(blob, filename);
      }
    } catch (e) {
      Log.warn("Native download fallback:", e.message);
      if (!isStale(dlId)) {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      if (!isStale(dlId)) resetBtn(btn);
      finishDownload(dlId);
    }
  }

  async function triggerMSEDownload(btn) {
    const dlId = startDownload();
    setBtnProgress(btn, "⏳");
    try {
      const of = uWindow.__omnifetch || {};
      const vChunks = of.videoChunks || [];
      const aChunks = of.audioChunks || [];
      if (vChunks.length === 0) {
        alert(
          "No captured video chunks.\nLet the video play to completion first.",
        );
        return;
      }

      const videoBlob = new Blob(vChunks, { type: "video/mp4" });
      if (aChunks.length > 0) {
        const audioBlob = new Blob(aChunks, { type: "audio/mp4" });
        btn.innerHTML = svgMux;
        const muxed = await muxVideoAudio(videoBlob, audioBlob);
        if (isStale(dlId)) return;
        if (muxed) triggerBlobDownload(muxed, "video_download.mp4");
        else {
          triggerBlobDownload(videoBlob, "video_track.mp4");
          setTimeout(
            () => triggerBlobDownload(audioBlob, "audio_track.m4a"),
            500,
          );
        }
      } else {
        triggerBlobDownload(videoBlob, "video_download.mp4");
      }
    } catch (e) {
      if (!isStale(dlId)) {
        Log.error("MSE download:", e.message);
        alert("MSE download failed: " + e.message);
      }
    } finally {
      if (!isStale(dlId)) resetBtn(btn);
      finishDownload(dlId);
    }
  }

  // =========================================================================
  // SECTION 11: DOWNLOAD LINK ROUTING
  // =========================================================================

  function updateDownloadLink(src) {
    let btn = document.getElementById("omnifetch-dl-btn");
    if (!btn) btn = createUI();
    const badge = document.getElementById("omnifetch-sniff-badge");

    if (badge && sniffedManifestUrls.length > 0) {
      badge.textContent = sniffedManifestUrls.length;
      badge.style.display = "flex";
    }

    // Don't overwrite button while a download is active
    if (!isIdle()) {
      buttonContainer.style.display = "flex";
      return;
    }

    if (src.startsWith("reddit:") && settings.enableReddit) {
      resetBtn(btn);
      const realUrl = src.split("reddit:")[1];
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) return;
        window.open(
          "https://rapidsave.com/info?url=" + encodeURIComponent(realUrl),
          "_blank",
        );
      };
    } else if (
      HOST.includes("youtube.com") &&
      settings.enableYouTube &&
      !src.startsWith("blob:")
    ) {
      resetBtn(btn);
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) return;
        triggerYT3PDownload(window.location.href, btn);
      };
    } else if (src.includes(".mpd")) {
      btn.innerHTML = svgSettings;
      btn.style.cursor = "pointer";
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) return;
        triggerDASHDownload(src, btn);
      };
    } else if (src.includes(".m3u8")) {
      resetBtn(btn);
      btn.onclick = (e) => {
        e.preventDefault();
        if (!isIdle()) return;
        triggerHLSDownload(src, btn);
      };
    } else if (src.startsWith("blob:")) {
      const of = uWindow.__omnifetch || {};
      if (of.mseComplete) {
        const hasAudio = (of.audioChunks || []).length > 0;
        const hasVideo = (of.videoChunks || []).length > 0;
        btn.innerHTML = hasAudio && hasVideo ? svgMux : svgCheck;
        btn.title =
          hasAudio && hasVideo
            ? "Download muxed video+audio"
            : "Download captured video";
        btn.style.cursor = "pointer";
        btn.onclick = (e) => {
          e.preventDefault();
          if (!isIdle()) return;
          triggerMSEDownload(btn);
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
        if (!isIdle()) return;
        triggerNativeDownload(src, btn);
      };
    }
    buttonContainer.style.display = "flex";
  }

  window.addEventListener("omnifetch-mse-complete", () => {
    if (activeVideoSrc) updateDownloadLink(activeVideoSrc);
  });

  // =========================================================================
  // SECTION 12: VIDEO DETECTION (event-driven + targeted observers)
  // =========================================================================

  function handleVideo(video) {
    // Resolve custom elements to inner <video>
    if (video.tagName !== "VIDEO") {
      const inner =
        video.querySelector("video") ||
        video.shadowRoot?.querySelector("video");
      if (inner) video = inner;
      else return;
    }
    if (!video || video.tagName !== "VIDEO") return;
    if (video.dataset.omnifetchHandled) return;
    video.dataset.omnifetchHandled = "true";

    const onPlaying = async () => {
      const src = await extractDirectVideoSrc(video);
      if (!src) return;
      activeVideoSrc = src;
      if (!isDirectVideoTab) {
        if (activeVideoElement && activeVideoElement !== video)
          activeVideoElement.classList.remove("omnifetch-active-video");
        activeVideoElement = video;
        video.classList.add("omnifetch-active-video");
      }
      updateDownloadLink(src);
    };

    video.addEventListener("playing", onPlaying);

    video.addEventListener("ended", async () => {
      if (video === activeVideoElement || !activeVideoElement) {
        const src = await extractDirectVideoSrc(video);
        if (src) {
          activeVideoSrc = src;
          updateDownloadLink(src);
        }
      }
    });

    // Passive pickup if nothing active yet
    if (!activeVideoSrc && (video.currentSrc || video.src)) {
      extractDirectVideoSrc(video).then((src) => {
        if (src && !activeVideoSrc) {
          activeVideoSrc = src;
          activeVideoElement = video;
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
          if (pl?.tech_?.el_) handleVideo(pl.tech_.el_);
        });
      } catch (e) {}
    }
    // JW Player
    if (uWindow.jwplayer) {
      try {
        const jw = uWindow.jwplayer();
        if (jw?.getContainer) {
          const v = jw.getContainer().querySelector("video");
          if (v) handleVideo(v);
        }
      } catch (e) {}
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
        if (doc) doc.querySelectorAll("video").forEach(handleVideo);
      } catch (e) {
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

  function resetState() {
    Log.info("Navigation reset");
    if (activeVideoElement)
      activeVideoElement.classList.remove("omnifetch-active-video");
    activeVideoSrc = null;
    activeVideoElement = null;
    isDirectVideoTab = false;

    // Cancel in-flight downloads and abort requests
    if (currentDownloadId !== 0) {
      abortAllRequests();
      currentDownloadId = 0;
    }

    sniffedManifestUrls = [];

    try {
      const of = uWindow.__omnifetch;
      if (of) {
        of.videoChunks = [];
        of.audioChunks = [];
        of.videoMime = "";
        of.audioMime = "";
        of.mseComplete = false;
        of.sniffedUrls = [];
        of.totalVideoBytes = 0;
        of.totalAudioBytes = 0;
      }
    } catch (e) {}

    const badge = document.getElementById("omnifetch-sniff-badge");
    if (badge) {
      badge.textContent = "0";
      badge.style.display = "none";
    }
    if (buttonContainer) buttonContainer.style.display = "none";
    hideProgressOverlay();
  }

  function rescanPage() {
    createUI();
    if (document.contentType?.startsWith("video/")) {
      isDirectVideoTab = true;
      activeVideoSrc = window.location.href;
      updateDownloadLink(activeVideoSrc);
      return;
    }
    document
      .querySelectorAll("video[data-omnifetch-handled]")
      .forEach((v) => delete v.dataset.omnifetchHandled);
    document.querySelectorAll("video, shreddit-player").forEach(handleVideo);
    scanForFrameworkPlayers();
    if (activeVideoSrc) updateDownloadLink(activeVideoSrc);
  }

  function onNavigationDetected(newUrl) {
    const oldBase = lastKnownUrl.split("#")[0];
    const newBase = newUrl.split("#")[0];
    if (oldBase === newBase) return;
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
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver((mutations) => {
      let hasNewVideos = false;
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
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
      if (hasNewVideos) scanForFrameworkPlayers();
    });
    // Safari safety: document.body may rarely be null even after DOMContentLoaded
    const observeTarget = document.body || document.documentElement;
    mutationObserver.observe(observeTarget, { childList: true, subtree: true });

    // Periodic fallback (reduced frequency, exponential backoff idea: fixed interval is simpler for userscript)
    if (rescanInterval) clearInterval(rescanInterval);
    rescanInterval = setInterval(() => {
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
        const url =
          sniffedManifestUrls.find((u) => u.includes(".m3u8")) ||
          sniffedManifestUrls.find((u) => u.includes(".mpd"));
        if (url) {
          activeVideoSrc = url;
          updateDownloadLink(url);
        }
      }
    }, settings.rescanIntervalMs);
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    abortAllRequests();
    if (mutationObserver) mutationObserver.disconnect();
    if (rescanInterval) clearInterval(rescanInterval);
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
