(function () {
  'use strict';

  const QUALITY_PRESETS = {
    '420':  { w:  420, h:  748 },
    '720':  { w:  720, h: 1280 },
    '1080': { w: 1080, h: 1920 },
  };

  let _quality = '1080';
  let OUT_W = QUALITY_PRESETS[_quality].w;
  let OUT_H = QUALITY_PRESETS[_quality].h;
  const FPS = 30;

  const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const _isSafariDesktop = !_isIOS && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  const _useBufferedMp4Audio = true;
  /** Bump when you deploy so Safari/Webflow cache issues are obvious in the console. */
  const _RENDER_SCRIPT_BUILD = 'pb-20260430';

  const _SUPABASE_URL      = 'https://fqzqanspjfvarotxexob.supabase.co';
  const _SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxenFhbnNwamZ2YXJvdHhleG9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyNjA5ODAsImV4cCI6MjA4NjgzNjk4MH0.xQC8A6bvLVT2-RuWcmbKK1Wf-wvlK3QgsjCNd1lD1w4';

  function _shortUUID() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const b of bytes) id += chars[b % chars.length];
    return id;
  }

  function _getSupabaseToken() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          return (data && data.access_token) ? data.access_token : null;
        } catch (_) {}
      }
    }
    return null;
  }

  async function _supabaseWriteRenderId(clipId, renderId) {
    try {
      const token = _getSupabaseToken();
      if (!token) return;
      await fetch(
        `${_SUPABASE_URL}/rest/v1/clips_live?id=eq.${encodeURIComponent(clipId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        _SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify({ render_id: renderId }),
        }
      );
      console.log('Render: wrote render_id to clips_live', renderId);
    } catch (e) {
      console.warn('Render: failed to write render_id to Supabase', e);
    }
  }
  const _supportsCtxFilter = (() => {
    try {
      const testCtx = document.createElement('canvas').getContext('2d');
      if (!testCtx || typeof testCtx.filter !== 'string') return false;
      const prev = testCtx.filter;
      testCtx.filter = 'blur(1px)';
      const supported = testCtx.filter === 'blur(1px)';
      testCtx.filter = prev;
      return supported;
    } catch (_) {
      return false;
    }
  })();

  /** Fixed 720p JPEG poster from one early frame (not tied to export quality). */
  const THUMB_EXPORT_PRESET = '720';
  /** 0-based frame index to snapshot (2 = third frame at 30fps ≈ 0.1s into clip). */
  const THUMB_FRAME_INDEX = 2;

  function _jpegBlobFromCanvas(canvas, quality) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const comma = dataUrl.indexOf(',');
    const b64 = dataUrl.slice(comma + 1);
    const binary = atob(b64);
    const u8 = new Uint8Array(binary.length);
    for (let k = 0; k < binary.length; k++) u8[k] = binary.charCodeAt(k);
    return new Blob([u8], { type: 'image/jpeg' });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INDEXEDDB CACHE — persist rendered blob across page reloads
  // Safe in iframes: all ops are no-op if IndexedDB is unavailable
  // ─────────────────────────────────────────────────────────────────────────────
  const IDB_NAME    = 'render_cache';
  const IDB_STORE   = 'outputs';
  const IDB_VERSION = 1;

  function _idbAvailable() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
    catch (_) { return false; }
  }

  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function _cacheBlob(clipId, data) {
    if (!_idbAvailable()) return;
    try {
      const db = await _openDB();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const rec = { blob: data.blob, filename: data.filename, type: data.blob.type, savedAt: Date.now() };
      if (data.renderId) rec.renderId = data.renderId;
      if (data.thumbBlob && data.thumbBlob.size) {
        rec.thumbBlob     = data.thumbBlob;
        rec.thumbFilename = data.thumbFilename || '';
      }
      tx.objectStore(IDB_STORE).put(rec, clipId);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      db.close();
      console.log('Render: cached to IndexedDB', clipId);
    } catch (e) { console.warn('Render: IndexedDB cache write failed (iframe?)', e); }
  }

  async function _loadCachedBlob(clipId) {
    if (!_idbAvailable()) return null;
    try {
      const db  = await _openDB();
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(clipId);
      const result = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
      db.close();
      return result || null;
    } catch (_) { return null; }
  }

  async function _clearCachedBlob(clipId) {
    if (!_idbAvailable()) return;
    try {
      const db = await _openDB();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(clipId);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      db.close();
    } catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WIZED SYNC — push render output into Wized variables
  // Safe in iframes: silently no-ops if Wized isn't ready or vars don't exist
  // ─────────────────────────────────────────────────────────────────────────────
  function _syncToWized(data) {
    try {
      window.Wized = window.Wized || [];
      window.Wized.push((Wized) => {
        try {
          const d = Wized.data.v;
          d.render_output_url      = data.url           || '';
          d.render_output_type     = data.type          || '';
          d.render_output_filename = data.filename      || '';
          d.render_output_ready    = !!data.ready;
          d.render_thumb_url       = data.thumbUrl      || '';
          d.render_thumb_filename  = data.thumbFilename || '';
          d.render_thumb_type      = data.thumbUrl ? 'image/jpeg' : '';
          d.render_thumb_ready     = !!data.thumbUrl;
          if ('renderId' in data) d.render_id = data.renderId || '';
        } catch (e) { console.warn('Render: Wized variable sync failed (vars may not exist yet)', e); }
      });
    } catch (e) { console.warn('Render: Wized push failed', e); }
  }

  const _WIZED_CLEAR = { url: '', type: '', filename: '', ready: false, thumbUrl: '', thumbFilename: '', renderId: '' };

  // ─────────────────────────────────────────────────────────────────────────────
  // MP4 SUPPORT (WebCodecs + Mediabunny) — lazy-loaded on first render
  // ─────────────────────────────────────────────────────────────────────────────
  let _canMP4 = null;
  let _mb = null;

  async function ensureMp4Support() {
    if (_canMP4 !== null) return _canMP4;
    if (typeof VideoEncoder === 'undefined') { _canMP4 = false; return false; }
    // AudioEncoder required for MP4 audio (buffered AAC from source file).
    // Chrome iOS lacks AudioEncoder — it falls through to MediaRecorder fallback.
    try {
      _mb = await import('https://esm.sh/mediabunny@1.42.0');
      _canMP4 = await _mb.canEncode('avc');
    } catch (_) {
      _canMP4 = false;
    }
    if (_canMP4) {
      if (_useBufferedMp4Audio && typeof AudioEncoder === 'undefined') {
        console.log('Render: WebCodecs H.264 available; no AudioEncoder — using MediaRecorder for muxed audio (WebM preferred on iOS)');
      } else {
        console.log('Render: MP4 output enabled (H.264 + AAC)');
      }
    } else {
      console.log('Render: MP4 not available, using WebM fallback');
    }
    return _canMP4;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────
  function loadVideo(src) {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.preload     = 'auto';
    v.playsInline = true;
    v.muted       = true;
    v.src         = src + (src.includes('?') ? '&' : '?') + '_r=' + Date.now();
    return new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', () => resolve(v), { once: true });
      v.addEventListener('error', () => reject(new Error(`Failed to load video: ${src}`)), { once: true });
      v.load();
    });
  }

  function loadImage(src) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src + (src.includes('?') ? '&' : '?') + '_r=' + Date.now();
    return new Promise((resolve, reject) => {
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    });
  }

  function getSupportedMimeType(candidates) {
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    }
    return '';
  }

  function trimAudioBuffer(audioCtx, sourceBuffer, startSec, endSec) {
    const sampleRate = sourceBuffer.sampleRate;
    const startFrame = Math.max(0, Math.floor(startSec * sampleRate));
    const endFrame = Math.min(sourceBuffer.length, Math.ceil(endSec * sampleRate));
    const frameLength = Math.max(1, endFrame - startFrame);
    const trimmed = audioCtx.createBuffer(sourceBuffer.numberOfChannels, frameLength, sampleRate);

    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
      const channelSlice = sourceBuffer.getChannelData(ch).subarray(startFrame, endFrame);
      trimmed.copyToChannel(channelSlice, ch, 0);
    }

    return trimmed;
  }

  function drawBackdropFrame(ctx, source, sourceW, sourceH, destW, destH, blurCanvas, blurCtx) {
    const drawCover = Math.max(destW / sourceW, destH / sourceH) * 1.1;
    const drawW = sourceW * drawCover;
    const drawH = sourceH * drawCover;
    const drawX = (destW - drawW) / 2;
    const drawY = (destH - drawH) / 2;

    if (_supportsCtxFilter) {
      ctx.save();
      ctx.filter = 'blur(20px)';
      ctx.drawImage(source, 0, 0, sourceW, sourceH, drawX, drawY, drawW, drawH);
      ctx.filter = 'none';
      ctx.restore();
      return;
    }

    if (!blurCanvas || !blurCtx) {
      ctx.drawImage(source, 0, 0, sourceW, sourceH, drawX, drawY, drawW, drawH);
      return;
    }

    const blurW = Math.max(1, Math.round(destW / 20));
    const blurH = Math.max(1, Math.round(destH / 20));
    if (blurCanvas.width !== blurW || blurCanvas.height !== blurH) {
      blurCanvas.width = blurW;
      blurCanvas.height = blurH;
    }

    const blurCover = Math.max(blurW / sourceW, blurH / sourceH) * 1.1;
    const blurDrawW = sourceW * blurCover;
    const blurDrawH = sourceH * blurCover;
    const blurDrawX = (blurW - blurDrawW) / 2;
    const blurDrawY = (blurH - blurDrawH) / 2;

    blurCtx.save();
    blurCtx.setTransform(1, 0, 0, 1, 0, 0);
    blurCtx.globalCompositeOperation = 'source-over';
    blurCtx.clearRect(0, 0, blurW, blurH);
    blurCtx.imageSmoothingEnabled = true;
    blurCtx.drawImage(source, 0, 0, sourceW, sourceH, blurDrawX, blurDrawY, blurDrawW, blurDrawH);
    blurCtx.restore();

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(blurCanvas, 0, 0, blurW, blurH, 0, 0, destW, destH);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function readPx(cs, prop) {
    return parseFloat(cs[prop]) || 0;
  }

  function parseBoxShadow(raw, SF) {
    if (!raw || raw === 'none') return null;
    const m = raw.match(
      /^(rgba?\([^)]+\)|#\w+|\w+)\s+([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px(?:\s+([-\d.]+)px)?/
    );
    if (!m) return null;
    return {
      color:   m[1],
      offsetX: parseFloat(m[2]) * SF,
      offsetY: parseFloat(m[3]) * SF,
      blur:    parseFloat(m[4]) * SF,
      spread:  parseFloat(m[5] || 0) * SF,
    };
  }

  function parseTextShadow(raw, SF) {
    if (!raw || raw === 'none') return null;
    const m = raw.match(
      /^(rgba?\([^)]+\)|#\w+|\w+)\s+([-\d.]+)px\s+([-\d.]+)px(?:\s+([-\d.]+)px)?/
    );
    if (!m) return null;
    return {
      color:   m[1],
      offsetX: parseFloat(m[2]) * SF,
      offsetY: parseFloat(m[3]) * SF,
      blur:    parseFloat(m[4] || 0) * SF,
    };
  }

  function snapshotTextLayout(SF) {
    const s = {};

    const textPad = document.querySelector('.text_pad');
    if (textPad) {
      const cs = getComputedStyle(textPad);
      s.padTop    = readPx(cs, 'paddingTop')    * SF;
      s.padBottom = readPx(cs, 'paddingBottom')  * SF;
      s.padLeft   = readPx(cs, 'paddingLeft')    * SF;
      s.padRight  = readPx(cs, 'paddingRight')   * SF;
    } else {
      s.padTop = s.padBottom = s.padLeft = s.padRight = 0.04 * OUT_W;
    }

    const textGroup = document.querySelector('.text_group');
    if (textGroup) {
      const cs = getComputedStyle(textGroup);
      s.groupGap = readPx(cs, 'gap') * SF;
    } else {
      s.groupGap = 0.015 * OUT_W;
    }

    const titlePill = document.querySelector('.title_pill');
    if (titlePill) {
      const cs = getComputedStyle(titlePill);
      s.tPillPadTop    = readPx(cs, 'paddingTop')    * SF;
      s.tPillPadRight  = readPx(cs, 'paddingRight')  * SF;
      s.tPillPadBottom = readPx(cs, 'paddingBottom')  * SF;
      s.tPillPadLeft   = readPx(cs, 'paddingLeft')   * SF;
      s.tPillRadius    = readPx(cs, 'borderRadius')   * SF;
      s.tPillMarginBot = readPx(cs, 'marginBottom')   * SF;
      s.tPillBg        = cs.backgroundColor;
      s.tPillBorderW   = readPx(cs, 'borderTopWidth') * SF;
      s.tPillBorderC   = cs.borderTopColor;
      s.tPillShadow    = parseBoxShadow(cs.boxShadow, SF);
      s.tPillOpacity   = parseFloat(cs.opacity) ?? 1;
    } else {
      s.tPillPadTop = s.tPillPadBottom = 0.008 * OUT_W;
      s.tPillPadLeft = s.tPillPadRight = 0.018 * OUT_W;
      s.tPillRadius = 0.0245 * OUT_W;
      s.tPillMarginBot = -0.01 * OUT_W;
      s.tPillBg = 'rgba(0,0,0,0.7)';
      s.tPillBorderW = 0; s.tPillBorderC = 'transparent';
      s.tPillShadow = null; s.tPillOpacity = 1;
    }

    const titleText = document.querySelector('.title_text');
    if (titleText) {
      const cs = getComputedStyle(titleText);
      s.tFontSize      = readPx(cs, 'fontSize') * SF;
      s.tFontWeight    = cs.fontWeight;
      s.tFontFamily    = cs.fontFamily;
      s.tColor         = cs.color;
      s.tLineHeight    = readPx(cs, 'lineHeight') * SF;
      s.tLetterSpacing = readPx(cs, 'letterSpacing') * SF;
      s.tTextShadow    = parseTextShadow(cs.textShadow, SF);
      s.tStrokeWidth   = readPx(cs, 'webkitTextStrokeWidth') * SF;
      s.tStrokeColor   = cs.webkitTextStrokeColor || 'transparent';
    } else {
      s.tFontSize = 0.06 * OUT_W;
      s.tFontWeight = '700'; s.tFontFamily = 'sans-serif'; s.tColor = '#fff';
      s.tLineHeight = s.tFontSize * 1.2;
      s.tLetterSpacing = 0; s.tTextShadow = null;
      s.tStrokeWidth = 0; s.tStrokeColor = 'transparent';
    }

    // ── Subtitle: read normal state, then toggle is-active to read active state ──
    const subPill = document.querySelector('.subtitle_pill');
    const subText = document.querySelector('.subtitle_text');

    if (subPill) {
      const cs = getComputedStyle(subPill);
      s.sPillPadTop    = readPx(cs, 'paddingTop')    * SF;
      s.sPillPadRight  = readPx(cs, 'paddingRight')  * SF;
      s.sPillPadBottom = readPx(cs, 'paddingBottom')  * SF;
      s.sPillPadLeft   = readPx(cs, 'paddingLeft')   * SF;
      s.sPillRadius    = readPx(cs, 'borderRadius')   * SF;
      s.sPillBg        = cs.backgroundColor;
      s.sPillBorderW   = readPx(cs, 'borderTopWidth') * SF;
      s.sPillBorderC   = cs.borderTopColor;
      s.sPillShadow    = parseBoxShadow(cs.boxShadow, SF);
      s.sPillOpacity   = parseFloat(cs.opacity) ?? 1;

      const wasActive = subPill.classList.contains('is-active');
      if (!wasActive) subPill.classList.add('is-active');
      const acs = getComputedStyle(subPill);
      s.sPillActiveBg      = acs.backgroundColor;
      s.sPillActiveBorderW = readPx(acs, 'borderTopWidth') * SF;
      s.sPillActiveBorderC = acs.borderTopColor;
      s.sPillActiveShadow  = parseBoxShadow(acs.boxShadow, SF);
      s.sPillActiveOpacity = parseFloat(acs.opacity) ?? 1;
      if (!wasActive) subPill.classList.remove('is-active');
    } else {
      s.sPillPadTop = s.sPillPadBottom = 0.006 * OUT_W;
      s.sPillPadLeft = s.sPillPadRight = 0.012 * OUT_W;
      s.sPillRadius = 0.015 * OUT_W;
      s.sPillBg = 'rgba(0,0,0,0.5)';
      s.sPillBorderW = 0; s.sPillBorderC = 'transparent';
      s.sPillShadow = null; s.sPillOpacity = 1;
      s.sPillActiveBg = s.sPillBg;
      s.sPillActiveBorderW = 0; s.sPillActiveBorderC = 'transparent';
      s.sPillActiveShadow = null; s.sPillActiveOpacity = 1;
    }

    if (subText) {
      const cs = getComputedStyle(subText);
      s.sFontSize      = readPx(cs, 'fontSize') * SF;
      s.sFontWeight    = cs.fontWeight;
      s.sFontFamily    = cs.fontFamily;
      s.sColor         = cs.color;
      s.sLineHeight    = readPx(cs, 'lineHeight') * SF;
      s.sLetterSpacing = readPx(cs, 'letterSpacing') * SF;
      s.sTextShadow    = parseTextShadow(cs.textShadow, SF);
      s.sStrokeWidth   = readPx(cs, 'webkitTextStrokeWidth') * SF;
      s.sStrokeColor   = cs.webkitTextStrokeColor || 'transparent';

      const pill = subText.closest('.subtitle_pill');
      const wasActive = pill?.classList.contains('is-active');
      if (pill && !wasActive) pill.classList.add('is-active');
      const acs = getComputedStyle(subText);
      s.sActiveColor       = acs.color;
      s.sActiveStrokeWidth = readPx(acs, 'webkitTextStrokeWidth') * SF;
      s.sActiveStrokeColor = acs.webkitTextStrokeColor || 'transparent';
      s.sActiveTextShadow  = parseTextShadow(acs.textShadow, SF);
      if (pill && !wasActive) pill.classList.remove('is-active');
    } else {
      s.sFontSize = 0.055 * OUT_W;
      s.sFontWeight = '700'; s.sFontFamily = 'sans-serif'; s.sColor = '#fff';
      s.sLineHeight = s.sFontSize * 1.2;
      s.sLetterSpacing = 0; s.sTextShadow = null;
      s.sStrokeWidth = 0; s.sStrokeColor = 'transparent';
      s.sActiveColor = '#fff'; s.sActiveStrokeWidth = 0;
      s.sActiveStrokeColor = 'transparent'; s.sActiveTextShadow = null;
    }

    return s;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER ENGINE
  // ─────────────────────────────────────────────────────────────────────────────
  async function renderComposition(onProgress) {
    const preset = QUALITY_PRESETS[_quality] || QUALITY_PRESETS['1080'];
    OUT_W = preset.w;
    OUT_H = preset.h;

    const api = window.canvasAPI;
    if (!api) throw new Error('canvasAPI not available');

    const frame   = document.querySelector('.clip_canvas');
    const gpHold  = document.querySelector('.gameplay_hold');
    const gpVideo = document.querySelector('[wized="stream_clip_video"]');
    if (!frame || !gpVideo?.videoWidth) throw new Error('Canvas or video not ready');
    if (frame._rendering) throw new Error('Render already in progress');

    const state = api.getState();
    const { effectiveStart, effectiveEnd, duration } = api.getTrackBounds();
    const tracks = api.getTracks();
    const totalDuration = effectiveEnd - effectiveStart;
    if (totalDuration <= 0) throw new Error('No playback range');

    frame._rendering = true;
    const _gpWasMuted = gpVideo.muted;
    gpVideo.pause();
    gpVideo.muted = true;
    onProgress?.(0);

    // ── 1. Load render resources ──────────────────────────────────────────
    console.log('Render: [1] loading video…');
    const rv = await loadVideo(gpVideo.currentSrc || gpVideo.src);
    rv.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0.01;pointer-events:none;';
    document.body.appendChild(rv);

    const chatUrl = document.querySelector('[wized="stream_clip_chat"]')?.textContent.trim();
    const chatVid = (chatUrl && state.chatVisible) ? await loadVideo(chatUrl).catch(() => null) : null;

    const imgSrc = state.imgSrc;
    const imgObj = (imgSrc && state.imageVisible) ? await loadImage(imgSrc).catch(() => null) : null;

    // ── 2. Read ALL text styles from live DOM, scale to render res ────────
    const editorW  = frame.clientWidth || 1;
    const SF       = OUT_W / editorW;
    const ts       = snapshotTextLayout(SF);

    // ── 3. Canvas + encoding ─────────────────────────────────────────────
    const rc  = document.createElement('canvas');
    rc.width  = OUT_W;
    rc.height = OUT_H;
    const ctx = rc.getContext('2d');

    const TW = QUALITY_PRESETS[THUMB_EXPORT_PRESET].w;
    const TH = QUALITY_PRESETS[THUMB_EXPORT_PRESET].h;
    const thumbC = document.createElement('canvas');
    thumbC.width = TW;
    thumbC.height = TH;
    const thumbCtx = thumbC.getContext('2d');
    const blurCanvas = document.createElement('canvas');
    const blurCtx = blurCanvas.getContext('2d');
    const chatFrameCanvas = document.createElement('canvas');
    const chatFrameCtx = chatFrameCanvas.getContext('2d');
    let drawFrameIndex = 0;
    let thumbJpegBlob = null;

    console.log('Render: [2] checking MP4 support…');
    const webCodecsMp4Ok = await ensureMp4Support();
    const useMp4 = webCodecsMp4Ok &&
      !(_useBufferedMp4Audio && typeof AudioEncoder === 'undefined');
    console.log('Render: [3] encoding setup — useMp4:', useMp4, _isIOS ? '(iOS detected)' : '');
    if (webCodecsMp4Ok && !useMp4) {
      console.log('Render: Mediabunny MP4 skipped here so audio can be captured via MediaRecorder');
    }
    let audioCtx = null;
    let output = null, videoSource = null, audioSource = null;
    let recorder = null, chunks = null;
    let lastVideoTimestamp = -1;
    let outputStarted = false;
    let startMp4Output = null;
    let setupMp4AudioSource = null;
    let mp4AudioBuffer = null;
    let mp4AudioAddPromise = null;

    if (useMp4) {
      const { Output, Mp4OutputFormat, BufferTarget,
              CanvasSource, AudioBufferSource: MBAudioBufferSource } = _mb;
      const createVideoSource = () => new CanvasSource(rc, {
        codec: 'avc',
        bitrate: 8_000_000,
      });
      const startTimeoutMs = 6000;

      try {
        audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') {
          await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
        }
      } catch (_) {
        console.warn('Render: audio routing failed, exporting video-only');
      }

      setupMp4AudioSource = async () => {
        if (!audioCtx || audioSource) return;
        if (typeof AudioEncoder === 'undefined') return;
        if (audioCtx.state === 'suspended') {
          await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
        }
        const audioRes = await fetch(gpVideo.currentSrc || gpVideo.src);
        if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
        const audioArrayBuffer = await audioRes.arrayBuffer();
        const decodedAudio = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));
        mp4AudioBuffer = trimAudioBuffer(audioCtx, decodedAudio, effectiveStart, effectiveEnd);
        audioSource = new MBAudioBufferSource({
          codec: 'aac',
          bitrate: 128_000,
        });
      };

      if (typeof AudioEncoder !== 'undefined') {
        await setupMp4AudioSource();
      }

      startMp4Output = async () => {
        if (outputStarted) return;
        console.log('Render: [4] creating Mediabunny output…');
        videoSource = createVideoSource();
        output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: new BufferTarget(),
        });
        output.addVideoTrack(videoSource, { frameRate: FPS });
        if (audioSource) output.addAudioTrack(audioSource);
        await Promise.race([
          output.start(),
          new Promise((_, rejectStart) => {
            setTimeout(() => rejectStart(new Error(`MP4 output start timed out after ${startTimeoutMs}ms`)), startTimeoutMs);
          }),
        ]);
        outputStarted = true;
        if (audioSource && mp4AudioBuffer) {
          mp4AudioAddPromise = audioSource.add(mp4AudioBuffer);
        }
        console.log('Render: [5] output started, starting timed capture…');
      };

    } else {
      if (typeof rc.captureStream !== 'function') {
        throw new Error('captureStream not supported — cannot record on this browser');
      }
      const stream = rc.captureStream(FPS);
      try {
        audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') {
          await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
        }
        const src  = audioCtx.createMediaElementSource(rv);
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(dest);
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch (_) {
        console.warn('Render: audio routing failed, exporting video-only');
      }

      const mimeCandidates = _isIOS
        ? [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4;codecs=h264,aac',
            'video/mp4',
          ]
        : [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4',
            'video/webm',
          ];
      const mimeType = getSupportedMimeType(mimeCandidates);
      if (!mimeType) throw new Error('No supported recording format found on this browser');
      console.log('Render: MediaRecorder fallback mimeType', mimeType);
      const recOpts = { mimeType, videoBitsPerSecond: 8_000_000 };
      if (mimeType.includes('webm')) recOpts.audioBitsPerSecond = 128_000;
      try {
        recorder = new MediaRecorder(stream, recOpts);
      } catch (_) {
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      }
      chunks   = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    }

    // ── 4. Compute layout ─────────────────────────────────────────────────
    const mode    = state.mode;
    const gpHoldH = mode === 'is-split' ? OUT_H * state.splitPct : OUT_H;
    const fcHoldH = mode === 'is-split' ? OUT_H - gpHoldH : 0;

    const vw = rv.videoWidth, vh = rv.videoHeight;

    // Gameplay cover + zoom + pan
    const coverScale = Math.max(OUT_W / vw, gpHoldH / vh);
    const zoom = state.gameplayZoom;
    const dw   = vw * coverScale * zoom;
    const dh   = vh * coverScale * zoom;

    const editorHW = gpHold.clientWidth  || 1;
    const editorHH = gpHold.clientHeight || 1;
    const editorL  = parseFloat(gpVideo.style.left) || 0;
    const editorT  = parseFloat(gpVideo.style.top)  || 0;
    const editorDW = gpVideo.offsetWidth  || 1;
    const editorDH = gpVideo.offsetHeight || 1;
    const panCX = (editorL + editorDW / 2) / editorHW;
    const panCY = (editorT + editorDH / 2) / editorHH;

    const gpL = dw > OUT_W
      ? Math.max(OUT_W - dw, Math.min(0, panCX * OUT_W - dw / 2))
      : (OUT_W - dw) / 2;
    const gpT = dh > gpHoldH
      ? Math.max(gpHoldH - dh, Math.min(0, panCY * gpHoldH - dh / 2))
      : (gpHoldH - dh) / 2;

    // Facecam crop coords
    const hasFacecam = state.facecamVisible && document.querySelector(
      '[wized="stream_clip_contains_facecam"]'
    )?.textContent.trim().toLowerCase() === 'true';

    let fcCrop = null;
    if (hasFacecam) {
      const x1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x1"]')?.textContent);
      const y1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y1"]')?.textContent);
      const x2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x2"]')?.textContent);
      const y2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y2"]')?.textContent);
      if ([x1, y1, x2, y2].every(isFinite) && x2 > x1 && y2 > y1) {
        fcCrop = { x1, y1, x2, y2 };
      }
    }

    // Image layout
    let imgLayout = null;
    if (imgObj && state.imageVisible) {
      const iw = state.imageScale * OUT_W;
      const ih = iw * (imgObj.naturalHeight / imgObj.naturalWidth);
      imgLayout = {
        x: state.imageX * OUT_W - iw / 2,
        y: state.imageY * OUT_H - ih / 2,
        w: iw, h: ih,
      };
    }

    // Chat layout
    let chatLayout = null;
    if (chatVid && state.chatVisible) {
      chatLayout = {
        x: state.chatX * OUT_W - (state.chatW * OUT_W) / 2,
        y: state.chatY * OUT_H - (state.chatH * OUT_H) / 2,
        w: state.chatW * OUT_W,
        h: state.chatH * OUT_H,
      };
    }

    // Title layout: word wrap using dynamic DOM sizes
    let titleLines = [];
    if (state.title) {
      const font = `${ts.tFontWeight} ${ts.tFontSize}px ${ts.tFontFamily}`;
      const mCtx = document.createElement('canvas').getContext('2d');
      mCtx.font = font;

      const wrapW = OUT_W - ts.padLeft - ts.padRight - ts.tPillPadLeft - ts.tPillPadRight;

      const words = state.title.split(' ');
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (mCtx.measureText(test).width > wrapW && current) {
          titleLines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) titleLines.push(current);
    }

    // Subtitle transcript + mode
    let transcript = null;
    let subChunks  = null;
    const CHUNK_SIZE = 3;
    const subMode = document.querySelector('.subtitle_hold')?.dataset.subtitleMode ?? 'word';
    try {
      const raw = document.querySelector('[wized="stream_clip_transcript"]')?.textContent.trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          transcript = parsed;
          if (subMode === 'chunk') {
            subChunks = [];
            for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
              subChunks.push(transcript.slice(i, i + CHUNK_SIZE));
            }
          }
        }
      }
    } catch (_) {}

    console.log('Render: [6] setting up timer…');
    // ── 5. Frame timer — Worker preferred, setInterval fallback ─────────
    //    All iOS/iPadOS browsers use WebKit and have unreliable Blob-URL
    //    Workers, so we skip the Worker on any iOS device + desktop Safari.
    const _skipWorkerTimer = _isIOS || _isSafariDesktop;
    let _useWorkerTimer = false;
    let _timerWorker = null;
    let _timerUrl = null;
    let _timerInterval = null;

    if (!_skipWorkerTimer) {
      try {
        const timerBlob = new Blob([`
          let iv;
          self.onmessage = e => {
            if (e.data === 'start') { clearInterval(iv); iv = setInterval(() => self.postMessage(0), ${Math.round(1000 / FPS)}); }
            else if (e.data === 'stop') { clearInterval(iv); }
          };
        `], { type: 'application/javascript' });
        _timerUrl = URL.createObjectURL(timerBlob);
        _timerWorker = new Worker(_timerUrl);
        _useWorkerTimer = true;
      } catch (_) {
        _useWorkerTimer = false;
      }
    }

    if (!_useWorkerTimer) {
      console.log('Render: using setInterval timer' + (_isIOS ? ' (iOS detected)' : _isSafariDesktop ? ' (Safari detected)' : ''));
    }

    // ── 6. Run ────────────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
      function cleanup() {
        frame._rendering = false;
        if (_useWorkerTimer && _timerWorker) {
          _timerWorker.postMessage('stop');
          _timerWorker.terminate();
          if (_timerUrl) URL.revokeObjectURL(_timerUrl);
        } else {
          clearInterval(_timerInterval);
        }
        rv.pause();
        gpVideo.pause();
        gpVideo.muted = _gpWasMuted;
        if (chatVid) chatVid.pause();
        rv.removeAttribute('src'); rv.load();
        try { rv.parentNode?.removeChild(rv); } catch (_) {}
        if (chatVid) { chatVid.removeAttribute('src'); chatVid.load(); }
        blurCanvas.width = 0;
        blurCanvas.height = 0;
        chatFrameCanvas.width = 0;
        chatFrameCanvas.height = 0;
        if (audioCtx) audioCtx.close().catch(() => {});
      }

      async function finishMp4() {
        try {
          if (!outputStarted || !videoSource || !output) throw new Error('MP4 output was not started');
          if (mp4AudioAddPromise) await mp4AudioAddPromise;
          videoSource.close();
          if (audioSource) audioSource.close();
          await output.finalize();
          cleanup();
          resolve({
            video: new Blob([output.target.buffer], { type: 'video/mp4' }),
            thumb: thumbJpegBlob,
          });
        } catch (e) { cleanup(); reject(e); }
      }

      let _recorderResolved = false;
      function finishRecorder() {
        if (_recorderResolved) return;
        _recorderResolved = true;
        const videoBlob = new Blob(chunks, { type: recorder?.mimeType || 'video/mp4' });
        if (!videoBlob.size) {
          cleanup();
          reject(new Error(`Recorder produced empty output (${recorder?.mimeType || 'unknown'})`));
          return;
        }
        cleanup();
        resolve({
          video: videoBlob,
          thumb: thumbJpegBlob,
        });
      }
      if (!useMp4) {
        recorder.onstop = finishRecorder;
        recorder.addEventListener('dataavailable', () => {
          if (recorder.state === 'inactive') finishRecorder();
        });
        recorder.onerror = e => { if (!_recorderResolved) { _recorderResolved = true; cleanup(); reject(e); } };
      }

      const prerollDuration = 2 / FPS;
      const prerollStart = Math.max(0, effectiveStart - prerollDuration);
      let primedExactStart = Math.abs(prerollStart - effectiveStart) < 0.0001;

      console.log('Render: seeking to', prerollStart.toFixed(3), '– priming decoder…');
      rv.currentTime      = prerollStart;
      gpVideo.currentTime = prerollStart;
      if (chatVid) chatVid.currentTime = prerollStart;

      rv.addEventListener('seeked', async function onSeeked() {
        rv.removeEventListener('seeked', onSeeked);
        if (!primedExactStart) {
          primedExactStart = true;
          rv.currentTime      = effectiveStart;
          gpVideo.currentTime = effectiveStart;
          if (chatVid) chatVid.currentTime = effectiveStart;
          console.log('Render: decoder primed, seeking exact start', effectiveStart.toFixed(3));
          rv.addEventListener('seeked', onSeeked, { once: true });
          return;
        }
        console.log('Render: seeked fired, starting play…');
        try {
          await rv.play();
          console.log('Render: play resolved — paused:', rv.paused, 'time:', rv.currentTime.toFixed(3));
          if (!(useMp4 && mp4AudioBuffer)) {
            rv.muted  = false;
            rv.volume = 1;
          }
          if (audioCtx?.state === 'suspended') {
            await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
          }
          if (useMp4) {
            await setupMp4AudioSource?.();
            await startMp4Output();
          }
        } catch (e) { console.error('Render: play failed', e); cleanup(); reject(e); return; }

        gpVideo.play().catch(() => {});
        if (chatVid) { chatVid.muted = true; chatVid.play().catch(() => {}); }
        if (!useMp4) recorder.start(100);

        function draw() {
          if (!frame._rendering) return;

          const t = rv.currentTime;
          if (t >= effectiveEnd - 0.03 || rv.ended) {
            if (_useWorkerTimer && _timerWorker) _timerWorker.postMessage('stop');
            else clearInterval(_timerInterval);
            rv.pause();
            gpVideo.pause();
            if (chatVid) chatVid.pause();
            if (useMp4) {
              finishMp4();
            } else {
              setTimeout(() => {
                try { if (recorder.state === 'recording') recorder.requestData(); } catch (_) {}
                try { recorder.stop(); } catch (_) {}
                setTimeout(() => { finishRecorder(); }, 2000);
              }, 150);
            }
            return;
          }

          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, OUT_W, OUT_H);

          // ── Layer 1: Blurred background (full/overlay modes) ──────────
          if (mode !== 'is-split') {
            drawBackdropFrame(ctx, rv, vw, vh, OUT_W, OUT_H, blurCanvas, blurCtx);
          }

          // ── Layer 2: Gameplay video ───────────────────────────────────
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, OUT_W, gpHoldH);
          ctx.clip();
          ctx.drawImage(rv, 0, 0, vw, vh, gpL, gpT, dw, dh);
          ctx.restore();

          // ── Layer 3: Facecam ──────────────────────────────────────────
          if (fcCrop && hasFacecam) {
            const srcX = fcCrop.x1 * vw, srcY = fcCrop.y1 * vh;
            const srcW = (fcCrop.x2 - fcCrop.x1) * vw;
            const srcH = (fcCrop.y2 - fcCrop.y1) * vh;

            if (mode === 'is-split') {
              const fcScale = Math.max(OUT_W / srcW, fcHoldH / srcH);
              const fcDW = srcW * fcScale, fcDH = srcH * fcScale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(0, gpHoldH, OUT_W, fcHoldH);
              ctx.clip();
              ctx.drawImage(rv, srcX, srcY, srcW, srcH,
                (OUT_W - fcDW) / 2, gpHoldH + (fcHoldH - fcDH) / 2, fcDW, fcDH);
              ctx.restore();
            } else if (mode === 'is-overlay') {
              const olW = state.facecamW * OUT_W;
              const olH = state.facecamH * OUT_H;
              const olX = state.facecamX * OUT_W - olW / 2;
              const olY = state.facecamY * OUT_H - olH / 2;
              const fcScale = Math.max(olW / srcW, olH / srcH);
              const fcDW = srcW * fcScale, fcDH = srcH * fcScale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(olX, olY, olW, olH);
              ctx.clip();
              ctx.drawImage(rv, srcX, srcY, srcW, srcH,
                olX + (olW - fcDW) / 2, olY + (olH - fcDH) / 2, fcDW, fcDH);
              ctx.restore();
            }
          }

          // ── Layer 4: Image overlay ────────────────────────────────────
          if (imgLayout && state.imageVisible) {
            const imgStart = tracks.image?.start ?? 0;
            const imgEnd   = tracks.image?.end ?? duration;
            if (t >= imgStart && t <= imgEnd) {
              ctx.drawImage(imgObj, imgLayout.x, imgLayout.y, imgLayout.w, imgLayout.h);
            }
          }

          // ── Layer 5: Chat overlay ─────────────────────────────────────
          if (chatVid && chatLayout && state.chatVisible) {
            ctx.save();
            const blend = state.chatBlend || 'screen';
            ctx.globalCompositeOperation = blend === 'normal' ? 'source-over' : blend;
            if (chatFrameCtx) {
              const chatFrameW = Math.max(1, Math.round(chatLayout.w));
              const chatFrameH = Math.max(1, Math.round(chatLayout.h));
              if (chatFrameCanvas.width !== chatFrameW || chatFrameCanvas.height !== chatFrameH) {
                chatFrameCanvas.width = chatFrameW;
                chatFrameCanvas.height = chatFrameH;
              }
              chatFrameCtx.save();
              chatFrameCtx.setTransform(1, 0, 0, 1, 0, 0);
              chatFrameCtx.globalCompositeOperation = 'source-over';
              chatFrameCtx.clearRect(0, 0, chatFrameCanvas.width, chatFrameCanvas.height);
              chatFrameCtx.drawImage(chatVid, 0, 0, chatFrameCanvas.width, chatFrameCanvas.height);
              chatFrameCtx.restore();
              ctx.drawImage(chatFrameCanvas, chatLayout.x, chatLayout.y, chatLayout.w, chatLayout.h);
            } else {
              ctx.drawImage(chatVid, chatLayout.x, chatLayout.y, chatLayout.w, chatLayout.h);
            }
            ctx.globalCompositeOperation = 'source-over';
            ctx.restore();
          }

          // ── Layer 6 & 7: Text (positions read live from canvasAPI) ────
          {
            const tl = api.getTextLayout();
            const titleY = (tl.titleY ?? 0) * OUT_H;
            const subY   = (tl.subY   ?? 0) * OUT_H;

            let drawTitleNow = false;
            if (titleLines.length && state.titleVisible) {
              const titleStart = tracks.title?.start ?? 0;
              const titleEnd   = tracks.title?.end ?? duration;
              drawTitleNow = t >= titleStart && t <= titleEnd;
            }

            if (drawTitleNow) {
              renderTitleAtY(ctx, titleLines, titleY, ts);
            }

            if (transcript && state.subtitleVisible) {
              const ms = t * 1000;
              if (subMode === 'chunk' && subChunks) {
                let foundChunk = -1, foundWord = -1;
                for (let ci = 0; ci < subChunks.length; ci++) {
                  for (let wi = 0; wi < subChunks[ci].length; wi++) {
                    const w = subChunks[ci][wi];
                    if (ms >= w.start && ms < w.end) { foundChunk = ci; foundWord = wi; break; }
                  }
                  if (foundChunk !== -1) break;
                }
                if (foundChunk !== -1) {
                  renderSubChunkAtY(ctx, subChunks[foundChunk], foundWord, subY, ts);
                }
              } else {
                const word = transcript.find(w => ms >= w.start && ms < w.end);
                if (word) {
                  renderSubWordAtY(ctx, word.text, subY, ts);
                }
              }
            }
          }

          if (drawFrameIndex === THUMB_FRAME_INDEX) {
            try {
              thumbCtx.drawImage(rc, 0, 0, TW, TH);
              thumbJpegBlob = _jpegBlobFromCanvas(thumbC, 0.88);
            } catch (e) { console.warn('Render: thumbnail capture failed', e); }
          }
          drawFrameIndex++;

          if (useMp4) {
            let videoTimestamp = Math.max(0, t - effectiveStart);
            if (videoTimestamp <= lastVideoTimestamp) videoTimestamp = lastVideoTimestamp + (1 / FPS);
            videoSource.add(videoTimestamp, 1 / FPS);
            lastVideoTimestamp = videoTimestamp;
          }

          const progress = (t - effectiveStart) / totalDuration;
          onProgress?.(Math.min(1, Math.max(0, progress)));
        }

        draw();

        if (_useWorkerTimer) {
          _timerWorker.onmessage = draw;
          _timerWorker.postMessage('start');
        } else {
          _timerInterval = setInterval(draw, Math.round(1000 / FPS));
        }
        console.log('Render: timer started, useWorker:', _useWorkerTimer);
      }, { once: true });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEXT DRAWING — fully dynamic from snapshotted DOM styles
  // ─────────────────────────────────────────────────────────────────────────────
  function drawPill(ctx, px, py, pw, ph, radius, bg, borderW, borderC, shadow, opacity) {
    ctx.save();
    if (opacity < 1) ctx.globalAlpha = opacity;

    if (shadow) {
      ctx.shadowColor   = shadow.color;
      ctx.shadowOffsetX = shadow.offsetX;
      ctx.shadowOffsetY = shadow.offsetY;
      ctx.shadowBlur    = shadow.blur;
    }

    ctx.fillStyle = bg;
    roundRect(ctx, px, py, pw, ph, radius);
    ctx.fill();

    ctx.shadowColor = 'transparent';

    if (borderW > 0) {
      ctx.lineWidth   = borderW;
      ctx.strokeStyle = borderC;
      roundRect(ctx, px, py, pw, ph, radius);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawStyledText(ctx, text, x, y, color, textShadow, strokeW, strokeC) {
    if (textShadow) {
      ctx.save();
      ctx.fillStyle     = textShadow.color;
      ctx.shadowColor   = textShadow.color;
      ctx.shadowOffsetX = textShadow.offsetX;
      ctx.shadowOffsetY = textShadow.offsetY;
      ctx.shadowBlur    = textShadow.blur;
      ctx.fillText(text, x, y);
      ctx.restore();
    }
    if (strokeW > 0) {
      ctx.save();
      ctx.lineWidth   = strokeW * 2;
      ctx.strokeStyle = strokeC;
      ctx.lineJoin    = 'round';
      ctx.strokeText(text, x, y);
      ctx.restore();
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }


  // ── Draw helpers (unchanged rendering, just at a given Y) ───────────
  function renderTitleAtY(ctx, lines, y, ts) {
    const font = `${ts.tFontWeight} ${ts.tFontSize}px ${ts.tFontFamily}`;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    if (ts.tLetterSpacing) ctx.letterSpacing = `${ts.tLetterSpacing}px`;

    const pillGap = ts.tPillMarginBot;

    lines.forEach(line => {
      const tw = ctx.measureText(line).width;
      const pw = tw + ts.tPillPadLeft + ts.tPillPadRight;
      const ph = ts.tLineHeight + ts.tPillPadTop + ts.tPillPadBottom;
      const px = (OUT_W - pw) / 2;

      drawPill(ctx, px, y, pw, ph,
        ts.tPillRadius, ts.tPillBg,
        ts.tPillBorderW, ts.tPillBorderC,
        ts.tPillShadow, ts.tPillOpacity);

      ctx.font = font; ctx.textAlign = 'center';
      if (ts.tLetterSpacing) ctx.letterSpacing = `${ts.tLetterSpacing}px`;
      drawStyledText(ctx, line, OUT_W / 2, y + ph / 2,
        ts.tColor, ts.tTextShadow, ts.tStrokeWidth, ts.tStrokeColor);

      y += ph + pillGap;
    });
    ctx.letterSpacing = '0px';
  }

  function renderSubWordAtY(ctx, text, y, ts) {
    const font = `${ts.sFontWeight} ${ts.sFontSize}px ${ts.sFontFamily}`;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;

    const tw = ctx.measureText(text).width;
    const pw = tw + ts.sPillPadLeft + ts.sPillPadRight;
    const ph = ts.sLineHeight + ts.sPillPadTop + ts.sPillPadBottom;
    const px = (OUT_W - pw) / 2;

    drawPill(ctx, px, y, pw, ph,
      ts.sPillRadius, ts.sPillActiveBg,
      ts.sPillActiveBorderW, ts.sPillActiveBorderC,
      ts.sPillActiveShadow, ts.sPillActiveOpacity);

    ctx.font = font; ctx.textAlign = 'center';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;
    drawStyledText(ctx, text, OUT_W / 2, y + ph / 2,
      ts.sActiveColor, ts.sActiveTextShadow,
      ts.sActiveStrokeWidth, ts.sActiveStrokeColor);
    ctx.letterSpacing = '0px';
  }

  function renderSubChunkAtY(ctx, chunk, activeIdx, y, ts) {
    const font = `${ts.sFontWeight} ${ts.sFontSize}px ${ts.sFontFamily}`;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;

    const wordGap = ts.sPillPadLeft;
    const ph = ts.sLineHeight + ts.sPillPadTop + ts.sPillPadBottom;
    const metrics = chunk.map(w => ({ text: w.text, tw: ctx.measureText(w.text).width }));
    const totalW = metrics.reduce((a, m) => a + m.tw + ts.sPillPadLeft + ts.sPillPadRight, 0)
                 + wordGap * Math.max(0, chunk.length - 1);
    let x = (OUT_W - totalW) / 2;

    metrics.forEach((m, i) => {
      const isActive = i === activeIdx;
      const pw = m.tw + ts.sPillPadLeft + ts.sPillPadRight;

      drawPill(ctx, x, y, pw, ph, ts.sPillRadius,
        isActive ? ts.sPillActiveBg     : ts.sPillBg,
        isActive ? ts.sPillActiveBorderW : ts.sPillBorderW,
        isActive ? ts.sPillActiveBorderC : ts.sPillBorderC,
        isActive ? ts.sPillActiveShadow  : ts.sPillShadow,
        isActive ? ts.sPillActiveOpacity : ts.sPillOpacity);

      ctx.font = font; ctx.textAlign = 'center';
      drawStyledText(ctx, m.text, x + pw / 2, y + ph / 2,
        isActive ? ts.sActiveColor      : ts.sColor,
        isActive ? ts.sActiveTextShadow  : ts.sTextShadow,
        isActive ? ts.sActiveStrokeWidth : ts.sStrokeWidth,
        isActive ? ts.sActiveStrokeColor : ts.sStrokeColor);

      x += pw + wordGap;
    });
    ctx.letterSpacing = '0px';
  }


  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC API — called from Wized, no DOM manipulation here
  // ─────────────────────────────────────────────────────────────────────────────
  let _rendering  = false;
  let _progress   = 0;
  let _status     = 'idle';   // 'idle' | 'rendering' | 'done' | 'failed'
  let _lastBlob      = null;
  let _lastUrl       = null;
  let _lastThumbBlob = null;
  let _lastThumbUrl  = null;

  /** Revoke any blob URLs from a previous listCachedRenders call. */
  let _listUrls = [];
  function _revokeListUrls() {
    _listUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    _listUrls = [];
  }

  window.renderAPI = {
    isRendering()    { return _rendering; },
    getProgress()    { return _progress; },
    getStatus()      { return _status; },
    getQuality()     { return _quality; },
    setQuality(q)    {
      if (QUALITY_PRESETS[q]) _quality = q;
    },
    getOutputBlob()  { return _lastBlob; },
    getOutputUrl()   { return _lastUrl; },
    getOutputType()  { return _lastBlob?.type || null; },
    getThumbBlob()   { return _lastThumbBlob; },
    getThumbUrl()    { return _lastThumbUrl; },

    async restoreLastRender() {
      let clipId = '';
      for (let i = 0; i < 40; i++) {
        clipId = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
        if (clipId) break;
        await new Promise(r => setTimeout(r, 250));
      }
      if (!clipId) { console.warn('Render: restore skipped — clip ID not found after 10s'); return false; }
      const cached = await _loadCachedBlob(clipId);
      if (!cached) return false;
      if (_lastUrl) URL.revokeObjectURL(_lastUrl);
      if (_lastThumbUrl) URL.revokeObjectURL(_lastThumbUrl);
      _lastBlob      = cached.blob;
      _lastUrl       = URL.createObjectURL(cached.blob);
      _lastThumbBlob = (cached.thumbBlob && cached.thumbBlob.size) ? cached.thumbBlob : null;
      _lastThumbUrl  = _lastThumbBlob ? URL.createObjectURL(_lastThumbBlob) : null;
      _syncToWized({
        url: _lastUrl, type: cached.type, filename: cached.filename, ready: true,
        thumbUrl: _lastThumbUrl || '', thumbFilename: cached.thumbFilename || '',
        renderId: cached.renderId || '',
      });
      console.log('Render: restored from IndexedDB', clipId);
      return true;
    },

    /**
     * Returns all cached renders. Each row always includes `thumbUrl`
     * (a blob: URL usable as <img src>) when a thumbnail exists.
     * Blob URLs from a previous call are revoked automatically.
     */
    async listCachedRenders() {
      _revokeListUrls();
      if (!_idbAvailable()) return [];
      try {
        const db    = await _openDB();
        const tx    = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const keys  = await new Promise((ok, err) => {
          const r = store.getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = err;
        });
        const entries = [];
        for (const key of keys) {
          const rec = await new Promise((ok, err) => {
            const r = store.get(key); r.onsuccess = () => ok(r.result); r.onerror = err;
          });
          const hasThumb = !!(rec.thumbBlob && rec.thumbBlob.size);
          let videoUrl = null;
          try {
            videoUrl = URL.createObjectURL(rec.blob);
            _listUrls.push(videoUrl);
          } catch (e) {
            console.warn('Render: could not create videoUrl for', key, e);
          }
          const row = {
            clipId:        key,
            filename:      rec.filename,
            type:          rec.type,
            savedAt:       new Date(rec.savedAt).toLocaleString(),
            sizeMB:        +(rec.blob.size / 1048576).toFixed(2),
            videoUrl,
            hasThumb,
            thumbFilename: rec.thumbFilename || null,
            thumbSizeKB:   hasThumb ? +(rec.thumbBlob.size / 1024).toFixed(1) : null,
            thumbUrl:      null,
          };
          if (hasThumb) {
            try {
              row.thumbUrl = URL.createObjectURL(rec.thumbBlob);
              _listUrls.push(row.thumbUrl);
            } catch (e) {
              console.warn('Render: could not create thumbUrl for', key, e);
            }
          }
          entries.push(row);
        }
        db.close();
        return entries;
      } catch (e) {
        console.warn('Render: listCachedRenders failed', e);
        return [];
      }
    },

    clearOutput() {
      if (_lastUrl) URL.revokeObjectURL(_lastUrl);
      if (_lastThumbUrl) URL.revokeObjectURL(_lastThumbUrl);
      _lastBlob = null;
      _lastUrl  = null;
      _lastThumbBlob = null;
      _lastThumbUrl  = null;
      _syncToWized(_WIZED_CLEAR);
      const clipId = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
      if (clipId) _clearCachedBlob(clipId);
    },
  };

  console.info('[canvas-render-done] loaded — build', _RENDER_SCRIPT_BUILD);

  window.renderClip = async function () {
    if (_rendering) { console.warn('Render: blocked — already rendering'); return; }

    _rendering = true;
    _progress  = 0;
    _status    = 'rendering';
    window.dispatchEvent(new CustomEvent('renderStateChange', { detail: { status: 'rendering', progress: 0 } }));

    try {
      const { video: blob, thumb: thumbBlob } = await renderComposition(progress => {
        _progress = Math.round(progress * 100);
        window.dispatchEvent(new CustomEvent('renderStateChange', { detail: { status: 'rendering', progress: _progress } }));
      });

      const title    = window.canvasAPI?.getState()?.title || '';
      const clipId   = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim() || 'clip';
      const renderId = _shortUUID();
      const safeName = (title || clipId).replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_');
      const ext      = blob.type === 'video/mp4' ? 'mp4' : 'webm';
      const filename = `${safeName || clipId}-render.${ext}`;
      const hasThumb = !!(thumbBlob && thumbBlob.size);
      const thumbFilename = hasThumb ? `${safeName || clipId}-thumb.jpg` : '';

      if (_lastUrl) URL.revokeObjectURL(_lastUrl);
      if (_lastThumbUrl) URL.revokeObjectURL(_lastThumbUrl);
      _lastBlob      = blob;
      _lastUrl       = URL.createObjectURL(blob);
      _lastThumbBlob = hasThumb ? thumbBlob : null;
      _lastThumbUrl  = hasThumb ? URL.createObjectURL(thumbBlob) : null;

      try {
        const a    = document.createElement('a');
        a.href     = _lastUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (_) { console.warn('Render: auto-download blocked (iframe sandbox)'); }

      _cacheBlob(clipId, { blob, filename, renderId, thumbBlob: hasThumb ? thumbBlob : null, thumbFilename });
      _supabaseWriteRenderId(clipId, renderId);
      _syncToWized({
        url: _lastUrl, type: blob.type, filename, ready: true,
        thumbUrl: _lastThumbUrl || '', thumbFilename, renderId,
      });

      _status   = 'done';
      _progress = 100;
      window.dispatchEvent(new CustomEvent('renderStateChange', { detail: { status: 'done', progress: 100 } }));
      setTimeout(() => { _status = 'idle'; _progress = 0; }, 3000);
    } catch (err) {
      console.error('Render failed:', err);
      _status = 'failed';
      _syncToWized(_WIZED_CLEAR);
      window.dispatchEvent(new CustomEvent('renderStateChange', { detail: { status: 'failed', progress: _progress } }));
      setTimeout(() => { _status = 'idle'; _progress = 0; }, 3000);
    } finally {
      _rendering = false;
      const frame = document.querySelector('.clip_canvas');
      if (frame) frame._rendering = false;
      document.querySelectorAll('video[style*="-9999px"]').forEach(v => {
        try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (_) {}
      });
    }
  };

})();