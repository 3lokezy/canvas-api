(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // QUALITY PRESETS
  // ─────────────────────────────────────────────────────────────────────────────
  const QUALITY_PRESETS = {
    '420':  { w:  420, h:  748 },
    '720':  { w:  720, h: 1280 },
    '1080': { w: 1080, h: 1920 },
  };

  let _quality = '1080';
  let OUT_W = QUALITY_PRESETS[_quality].w;
  let OUT_H = QUALITY_PRESETS[_quality].h;
  const FPS = 30;

  // ─────────────────────────────────────────────────────────────────────────────
  // DEVICE DETECTION
  // ─────────────────────────────────────────────────────────────────────────────
  const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  const _isSafariDesktop = !_isIOS &&
    /Safari/.test(navigator.userAgent) &&
    !/Chrome/.test(navigator.userAgent);

  // Chrome iOS (CriOS) reports MediaRecorder video/mp4 support but silently
  // produces empty output. Force Mediabunny so it follows the raw-AAC remux path
  // instead, which produces a valid MP4 with audio.
  const _isChromeIOS = _isIOS && /CriOS/.test(navigator.userAgent);

  /** Bump on deploy to surface cache/CDN issues in the console. */
  const _RENDER_SCRIPT_BUILD = 'pb-20260505v';

  // ─────────────────────────────────────────────────────────────────────────────
  // SUPABASE
  // ─────────────────────────────────────────────────────────────────────────────
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
          method:  'PATCH',
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

  // Publish a Wized flag so the UI can show a "use Safari for audio" nudge on
  // Chrome iOS, which lacks AudioEncoder. Auto-clears if Apple ships it later.
  (function _publishAudioCapabilityFlag() {
    const noAudio = _isIOS && typeof AudioEncoder === 'undefined';
    try {
      window.Wized = window.Wized || [];
      window.Wized.push((Wized) => {
        try { Wized.data.v.render_no_audio_browser = noAudio; } catch (_) {}
      });
    } catch (_) {}
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // CANVAS FILTER SUPPORT — detect ctx.filter (not available in all WebKit builds)
  // ─────────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────────
  // THUMBNAIL CONFIG
  // ─────────────────────────────────────────────────────────────────────────────

  /** Fixed 720p JPEG poster — not tied to export quality. */
  const THUMB_EXPORT_PRESET = '720';
  /** 0-based frame index to snapshot (2 = third frame ≈ 0.1 s in). */
  const THUMB_FRAME_INDEX = 2;

  function _jpegBlobFromCanvas(canvas, quality) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const b64     = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary  = atob(b64);
    const u8      = new Uint8Array(binary.length);
    for (let k = 0; k < binary.length; k++) u8[k] = binary.charCodeAt(k);
    return new Blob([u8], { type: 'image/jpeg' });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INDEXEDDB CACHE
  // Persists the rendered blob across page reloads. All ops are silent no-ops
  // when IndexedDB is unavailable (cross-origin iframes, private browsing, etc).
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
      const db  = await _openDB();
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const rec = {
        blob:     data.blob,
        filename: data.filename,
        type:     data.blob.type,
        savedAt:  Date.now(),
      };
      if (data.renderId)      rec.renderId     = data.renderId;
      if (data.thumbBlob?.size) {
        rec.thumbBlob     = data.thumbBlob;
        rec.thumbFilename = data.thumbFilename || '';
      }
      tx.objectStore(IDB_STORE).put(rec, clipId);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      db.close();
      console.log('Render: cached to IndexedDB', clipId);
    } catch (e) { console.warn('Render: IndexedDB cache write failed', e); }
  }

  async function _loadCachedBlob(clipId) {
    if (!_idbAvailable()) return null;
    try {
      const db  = await _openDB();
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(clipId);
      const result = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror   = rej;
      });
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
  // WIZED SYNC
  // Pushes render state into Wized variables. Silent no-op if Wized isn't ready
  // or the target variables don't exist.
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
        } catch (e) { console.warn('Render: Wized variable sync failed', e); }
      });
    } catch (e) { console.warn('Render: Wized push failed', e); }
  }

  const _WIZED_CLEAR = {
    url: '', type: '', filename: '', ready: false,
    thumbUrl: '', thumbFilename: '', renderId: '',
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // MP4 SUPPORT — WebCodecs + Mediabunny, lazy-loaded on first render
  // ─────────────────────────────────────────────────────────────────────────────
  let _canMP4 = null;
  let _mb     = null;
  let _mbMp4  = null;

  async function ensureMp4Support() {
    if (_canMP4 !== null) return _canMP4;
    if (typeof VideoEncoder === 'undefined') { _canMP4 = false; return false; }
    try {
      _mb     = await import('https://cdn.jsdelivr.net/npm/mediabunny@1.42.0/+esm');
      _canMP4 = await _mb.canEncode('avc');
    } catch (_) {
      _canMP4 = false;
    }
    if (_canMP4) {
      if (typeof AudioEncoder === 'undefined') {
        // All iOS without AudioEncoder (Chrome iOS always; Safari iOS < 16.4).
        // Mediabunny produces video-only MP4 (CFR) — raw AAC is remuxed from the
        // source file in extractRawMp4Audio so we still get audio in the output.
        // CFR avoids TikTok's frame_rate_check_failed rejection.
        console.log('Render: WebCodecs H.264 available; no AudioEncoder —',
          _isChromeIOS
            ? 'raw-AAC remux path (Chrome iOS)'
            : 'raw-AAC remux path (Safari iOS, CFR for TikTok)');
      } else {
        console.log('Render: MP4 output enabled (H.264 + AAC via AudioEncoder)');
      }
    } else {
      console.log('Render: H.264 unavailable — MediaRecorder fallback');
    }
    return _canMP4;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RAW AAC EXTRACTION — iOS without AudioEncoder
  // Pulls raw AAC samples directly from the source MP4 and injects them into
  // the Mediabunny video-only output at finalize time. No re-encoding needed.
  // ─────────────────────────────────────────────────────────────────────────────
  function _toMp4BoxBuf(buf) {
    let ab;
    if (buf instanceof ArrayBuffer) {
      ab = buf;
    } else {
      ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    ab.fileStart = 0;
    return ab;
  }

  async function extractRawMp4Audio(sourceUrl, startSec, endSec, signal) {
    // mp4box is lazy-loaded only when needed. Importing it alongside Mediabunny
    // on non-iOS platforms interferes with the H.264 encoder init.
    if (!_mbMp4) {
      try { _mbMp4 = await import('https://esm.sh/mp4box@0.5.2'); }
      catch (e) { console.warn('Render: mp4box import failed:', e); return null; }
    }
    const MP4Box = _mbMp4?.default ?? _mbMp4;
    if (typeof MP4Box?.createFile !== 'function') {
      console.warn('Render: mp4box.createFile not found');
      return null;
    }

    if (signal?.aborted) return null;
    console.log('Render: fetching source audio for remux…');
    const res = await fetch(sourceUrl, { cache: 'no-store', ...(signal ? { signal } : {}) });
    if (!res.ok) { console.warn('Render: source audio fetch failed', res.status); return null; }
    const srcBuf = _toMp4BoxBuf(await res.arrayBuffer());
    if (signal?.aborted) return null;
    console.log('Render: source audio fetched —', (srcBuf.byteLength / 1048576).toFixed(1), 'MB');

    return new Promise((resolve, reject) => {
      let file;
      try { file = MP4Box.createFile(); }
      catch (e) { reject(e); return; }

      let track = null, desc = null;
      const samples = [];
      let settled        = false;
      let totalReceived  = 0;

      const settle = result => { if (!settled) { settled = true; resolve(result); } };
      const fail   = err   => { if (!settled) { settled = true; reject(err); } };

      file.onReady = info => {
        track = info.audioTracks?.[0];
        if (!track) { settle(null); return; }
        try { desc = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0]; } catch (_) {}
        file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        file.start();
      };

      file.onSamples = (id, _, batch) => {
        if (!track) return;
        const s0 = Math.round(startSec * track.timescale);
        const s1 = Math.round(endSec   * track.timescale);
        for (const s of batch) {
          if (s.dts >= s0 && s.dts < s1) {
            samples.push({
              data:        s.data,
              dts:         s.dts - s0,
              cts:         (s.cts ?? s.dts) - s0,
              duration:    s.duration,
              is_sync:     s.is_sync !== false,
              description: s.description ?? desc,
            });
          }
        }
        totalReceived += batch.length;
        // mp4box@0.5.2: onFlush is unreliable — resolve by sample count instead.
        if (track.nb_samples && totalReceived >= track.nb_samples) {
          settle(samples.length ? { track, desc, samples } : null);
        }
      };

      file.onFlush = () => settle(track && samples.length ? { track, desc, samples } : null);
      file.onError = e => fail(new Error(String(e)));

      try { file.appendBuffer(srcBuf); file.flush(); }
      catch (e) { fail(e); }
    });
  }

  async function remuxWithAudio(videoBuffer, audioData) {
    const MP4Box = _mbMp4?.default ?? _mbMp4;
    if (!MP4Box) return videoBuffer;

    const vBuf = _toMp4BoxBuf(videoBuffer);

    const { vTrack, vDesc, vSamples } = await new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      let vTrack = null, vDesc = null;
      const vSamples = [];
      let settled       = false;
      let totalReceived = 0;

      const vSettle = r => { if (!settled) { settled = true; resolve(r); } };
      const vFail   = e => { if (!settled) { settled = true; reject(e); } };

      file.onReady = info => {
        vTrack = info.videoTracks?.[0];
        if (!vTrack) { vFail(new Error('remuxWithAudio: no video track')); return; }
        try { vDesc = file.getTrackById(vTrack.id).mdia.minf.stbl.stsd.entries[0]; } catch (_) {}
        file.setExtractionOptions(vTrack.id, null, { nbSamples: Infinity });
        file.start();
      };

      file.onSamples = (id, _, batch) => {
        vSamples.push(...batch);
        totalReceived += batch.length;
        if (vTrack?.nb_samples && totalReceived >= vTrack.nb_samples) {
          vSettle({ vTrack, vDesc, vSamples });
        }
      };
      file.onFlush  = () => vSettle({ vTrack, vDesc, vSamples });
      file.onError  = e => vFail(new Error(String(e)));
      file.appendBuffer(vBuf);
      file.flush();
    });

    const outFile = MP4Box.createFile();

    // addTrack's `description` must be the codec config child box, NOT the
    // sample-entry box itself. Passing vDesc (e.g. avc1) would nest avc1 inside
    // avc1 with no SPS/PPS, producing undecodable output.
    const vCodecBox = vDesc?.avcC ?? vDesc?.hvcC ?? vDesc?.vpcC ?? vDesc?.av1C;
    const aCodecBox = audioData.desc?.esds ?? audioData.desc?.dac3 ?? audioData.desc;

    const videoId = outFile.addTrack({
      id: 1, type: vDesc?.type ?? 'avc1',
      timescale: vTrack.timescale,
      width:     vTrack.video.width,
      height:    vTrack.video.height,
      description: vCodecBox,
      hdlr: 'vide',
    });

    const audioId = outFile.addTrack({
      id: 2, type: audioData.desc?.type ?? 'mp4a',
      timescale:     audioData.track.timescale,
      samplerate:    audioData.track.audio.sample_rate,
      channel_count: audioData.track.audio.channel_count,
      samplesize:    16,
      description:   aCodecBox,
      hdlr: 'soun',
    });

    for (const s of vSamples) {
      outFile.addSample(videoId, s.data, {
        duration: s.duration, dts: s.dts, cts: s.cts ?? s.dts, is_sync: s.is_sync,
      });
    }
    for (const s of audioData.samples) {
      outFile.addSample(audioId, s.data, {
        duration: s.duration, dts: s.dts, cts: s.cts ?? s.dts, is_sync: s.is_sync,
      });
    }

    return outFile.getBuffer();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MEDIA HELPERS
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
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function trimAudioBuffer(audioCtx, sourceBuffer, startSec, endSec) {
    const sr         = sourceBuffer.sampleRate;
    const startFrame = Math.max(0, Math.floor(startSec * sr));
    const endFrame   = Math.min(sourceBuffer.length, Math.ceil(endSec * sr));
    const frameLen   = Math.max(1, endFrame - startFrame);
    const trimmed    = audioCtx.createBuffer(sourceBuffer.numberOfChannels, frameLen, sr);
    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
      trimmed.copyToChannel(
        sourceBuffer.getChannelData(ch).subarray(startFrame, endFrame),
        ch, 0
      );
    }
    return trimmed;
  }

  function mixAudioBuffers(audioCtx, clipBuffer, clipVolume, musicBuffer, musicVolume, musicOffset, musicTrackStart, musicTrackEnd, effectiveStart) {
    const sr           = audioCtx.sampleRate;
    const outputLength = clipBuffer.length;
    const outputBuffer = audioCtx.createBuffer(2, outputLength, sr);
  
    for (let ch = 0; ch < 2; ch++) {
      const outData  = outputBuffer.getChannelData(ch);
  
      // Clip audio
      const clipCh   = Math.min(ch, clipBuffer.numberOfChannels - 1);
      const clipData = clipBuffer.getChannelData(clipCh);
      for (let i = 0; i < outputLength; i++) {
        outData[i] = clipData[i] * clipVolume;
      }
  
      // Music audio — only within its track window
      if (musicBuffer) {
        const musicCh           = Math.min(ch, musicBuffer.numberOfChannels - 1);
        const musicData         = musicBuffer.getChannelData(musicCh);
        const musicStartFrame   = Math.round((musicTrackStart - effectiveStart) * sr);
        const musicEndFrame     = Math.round((musicTrackEnd   - effectiveStart) * sr);
        const musicOffsetFrames = Math.round(musicOffset * sr);
  
        for (let i = Math.max(0, musicStartFrame); i < Math.min(outputLength, musicEndFrame); i++) {
          const musicFrame = musicOffsetFrames + (i - musicStartFrame);
          if (musicFrame >= 0 && musicFrame < musicData.length) {
            outData[i] += musicData[musicFrame] * musicVolume;
          }
        }
      }
    }
  
    return outputBuffer;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CANVAS DRAW HELPERS
  // ─────────────────────────────────────────────────────────────────────────────
  function drawBackdropFrame(ctx, source, sourceW, sourceH, destW, destH, blurCanvas, blurCtx) {
    const scale = Math.max(destW / sourceW, destH / sourceH) * 1.1;
    const drawW = sourceW * scale, drawH = sourceH * scale;
    const drawX = (destW - drawW) / 2, drawY = (destH - drawH) / 2;

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

    // Software blur: downscale to ~1/20th then upscale back to destination.
    const blurW = Math.max(1, Math.round(destW / 20));
    const blurH = Math.max(1, Math.round(destH / 20));
    if (blurCanvas.width !== blurW || blurCanvas.height !== blurH) {
      blurCanvas.width  = blurW;
      blurCanvas.height = blurH;
    }

    const bc  = Math.max(blurW / sourceW, blurH / sourceH) * 1.1;
    const bDW = sourceW * bc, bDH = sourceH * bc;
    const bDX = (blurW - bDW) / 2, bDY = (blurH - bDH) / 2;

    blurCtx.save();
    blurCtx.setTransform(1, 0, 0, 1, 0, 0);
    blurCtx.globalCompositeOperation = 'source-over';
    blurCtx.clearRect(0, 0, blurW, blurH);
    blurCtx.imageSmoothingEnabled = true;
    blurCtx.drawImage(source, 0, 0, sourceW, sourceH, bDX, bDY, bDW, bDH);
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

  function readPx(cs, prop) { return parseFloat(cs[prop]) || 0; }

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

  // ─────────────────────────────────────────────────────────────────────────────
  // DOM STYLE SNAPSHOT
  // Reads live CSS values and scales them to render resolution (OUT_W).
  // Called once before the render loop starts so styles are stable throughout.
  // ─────────────────────────────────────────────────────────────────────────────
  function snapshotTextLayout(SF) {
    const s = {};

    const textPad = document.querySelector('.text_pad');
    if (textPad) {
      const cs    = getComputedStyle(textPad);
      s.padTop    = readPx(cs, 'paddingTop')    * SF;
      s.padBottom = readPx(cs, 'paddingBottom') * SF;
      s.padLeft   = readPx(cs, 'paddingLeft')   * SF;
      s.padRight  = readPx(cs, 'paddingRight')  * SF;
    } else {
      s.padTop = s.padBottom = s.padLeft = s.padRight = 0.04 * OUT_W;
    }

    const textGroup = document.querySelector('.text_group');
    s.groupGap = textGroup
      ? readPx(getComputedStyle(textGroup), 'gap') * SF
      : 0.015 * OUT_W;

    // ── Title pill ────────────────────────────────────────────────────────────
    const titlePill = document.querySelector('.title_pill');
    if (titlePill) {
      const cs         = getComputedStyle(titlePill);
      s.tPillPadTop    = readPx(cs, 'paddingTop')    * SF;
      s.tPillPadRight  = readPx(cs, 'paddingRight')  * SF;
      s.tPillPadBottom = readPx(cs, 'paddingBottom') * SF;
      s.tPillPadLeft   = readPx(cs, 'paddingLeft')   * SF;
      s.tPillRadius    = readPx(cs, 'borderRadius')  * SF;
      s.tPillMarginBot = readPx(cs, 'marginBottom')  * SF;
      s.tPillBg        = cs.backgroundColor;
      s.tPillBorderW   = readPx(cs, 'borderTopWidth') * SF;
      s.tPillBorderC   = cs.borderTopColor;
      s.tPillShadow    = parseBoxShadow(cs.boxShadow, SF);
      s.tPillOpacity   = parseFloat(cs.opacity) ?? 1;
    } else {
      s.tPillPadTop = s.tPillPadBottom = 0.008 * OUT_W;
      s.tPillPadLeft = s.tPillPadRight = 0.018 * OUT_W;
      s.tPillRadius    = 0.0245 * OUT_W;
      s.tPillMarginBot = -0.01 * OUT_W;
      s.tPillBg        = 'rgba(0,0,0,0.7)';
      s.tPillBorderW   = 0;
      s.tPillBorderC   = 'transparent';
      s.tPillShadow    = null;
      s.tPillOpacity   = 1;
    }

    const titleText = document.querySelector('.title_text');
    if (titleText) {
      const cs         = getComputedStyle(titleText);
      s.tFontSize      = readPx(cs, 'fontSize')             * SF;
      s.tFontWeight    = cs.fontWeight;
      s.tFontFamily    = cs.fontFamily;
      s.tColor         = cs.color;
      s.tLineHeight    = readPx(cs, 'lineHeight')            * SF;
      s.tLetterSpacing = readPx(cs, 'letterSpacing')         * SF;
      s.tTextShadow    = parseTextShadow(cs.textShadow, SF);
      s.tStrokeWidth   = readPx(cs, 'webkitTextStrokeWidth') * SF;
      s.tStrokeColor   = cs.webkitTextStrokeColor || 'transparent';
    } else {
      s.tFontSize      = 0.06 * OUT_W;
      s.tFontWeight    = '700';
      s.tFontFamily    = 'sans-serif';
      s.tColor         = '#fff';
      s.tLineHeight    = s.tFontSize * 1.2;
      s.tLetterSpacing = 0;
      s.tTextShadow    = null;
      s.tStrokeWidth   = 0;
      s.tStrokeColor   = 'transparent';
    }

    // ── Subtitle pill — read default then is-active state ─────────────────────
    const subPill = document.querySelector('.subtitle_pill');
    const subText = document.querySelector('.subtitle_text');

    if (subPill) {
      const cs         = getComputedStyle(subPill);
      s.sPillPadTop    = readPx(cs, 'paddingTop')    * SF;
      s.sPillPadRight  = readPx(cs, 'paddingRight')  * SF;
      s.sPillPadBottom = readPx(cs, 'paddingBottom') * SF;
      s.sPillPadLeft   = readPx(cs, 'paddingLeft')   * SF;
      s.sPillRadius    = readPx(cs, 'borderRadius')  * SF;
      s.sPillBg        = cs.backgroundColor;
      s.sPillBorderW   = readPx(cs, 'borderTopWidth') * SF;
      s.sPillBorderC   = cs.borderTopColor;
      s.sPillShadow    = parseBoxShadow(cs.boxShadow, SF);
      s.sPillOpacity   = parseFloat(cs.opacity) ?? 1;

      const wasActive = subPill.classList.contains('is-active');
      if (!wasActive) subPill.classList.add('is-active');
      const acs            = getComputedStyle(subPill);
      s.sPillActiveBg      = acs.backgroundColor;
      s.sPillActiveBorderW = readPx(acs, 'borderTopWidth') * SF;
      s.sPillActiveBorderC = acs.borderTopColor;
      s.sPillActiveShadow  = parseBoxShadow(acs.boxShadow, SF);
      s.sPillActiveOpacity = parseFloat(acs.opacity) ?? 1;
      if (!wasActive) subPill.classList.remove('is-active');
    } else {
      s.sPillPadTop = s.sPillPadBottom = 0.006 * OUT_W;
      s.sPillPadLeft = s.sPillPadRight = 0.012 * OUT_W;
      s.sPillRadius        = 0.015 * OUT_W;
      s.sPillBg            = 'rgba(0,0,0,0.5)';
      s.sPillBorderW       = 0;
      s.sPillBorderC       = 'transparent';
      s.sPillShadow        = null;
      s.sPillOpacity       = 1;
      s.sPillActiveBg      = s.sPillBg;
      s.sPillActiveBorderW = 0;
      s.sPillActiveBorderC = 'transparent';
      s.sPillActiveShadow  = null;
      s.sPillActiveOpacity = 1;
    }

    if (subText) {
      const cs         = getComputedStyle(subText);
      s.sFontSize      = readPx(cs, 'fontSize')             * SF;
      s.sFontWeight    = cs.fontWeight;
      s.sFontFamily    = cs.fontFamily;
      s.sColor         = cs.color;
      s.sLineHeight    = readPx(cs, 'lineHeight')            * SF;
      s.sLetterSpacing = readPx(cs, 'letterSpacing')         * SF;
      s.sTextShadow    = parseTextShadow(cs.textShadow, SF);
      s.sStrokeWidth   = readPx(cs, 'webkitTextStrokeWidth') * SF;
      s.sStrokeColor   = cs.webkitTextStrokeColor || 'transparent';

      const pill      = subText.closest('.subtitle_pill');
      const wasActive = pill?.classList.contains('is-active');
      if (pill && !wasActive) pill.classList.add('is-active');
      const acs            = getComputedStyle(subText);
      s.sActiveColor       = acs.color;
      s.sActiveStrokeWidth = readPx(acs, 'webkitTextStrokeWidth') * SF;
      s.sActiveStrokeColor = acs.webkitTextStrokeColor || 'transparent';
      s.sActiveTextShadow  = parseTextShadow(acs.textShadow, SF);
      if (pill && !wasActive) pill.classList.remove('is-active');
    } else {
      s.sFontSize          = 0.055 * OUT_W;
      s.sFontWeight        = '700';
      s.sFontFamily        = 'sans-serif';
      s.sColor             = '#fff';
      s.sLineHeight        = s.sFontSize * 1.2;
      s.sLetterSpacing     = 0;
      s.sTextShadow        = null;
      s.sStrokeWidth       = 0;
      s.sStrokeColor       = 'transparent';
      s.sActiveColor       = '#fff';
      s.sActiveStrokeWidth = 0;
      s.sActiveStrokeColor = 'transparent';
      s.sActiveTextShadow  = null;
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

    const state                                    = api.getState();
    const { effectiveStart, effectiveEnd, duration } = api.getTrackBounds();
    const tracks        = api.getTracks();
    const totalDuration = effectiveEnd - effectiveStart;
    if (totalDuration <= 0) throw new Error('No playback range');

    frame._rendering  = true;
    const _gpWasMuted = gpVideo.muted;
    gpVideo.pause();
    gpVideo.muted = true;
    onProgress?.(0);

    // ── 1. Load render resources ──────────────────────────────────────────────
    console.log('Render: [1] loading video…');
    const rv = await loadVideo(gpVideo.currentSrc || gpVideo.src);
    // Off-screen but compositor-visible so requestVideoFrameCallback fires.
    rv.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-9999;';
    document.body.appendChild(rv);

    const chatUrl = document.querySelector('[wized="stream_clip_chat"]')?.textContent.trim();
    const chatVid = (chatUrl && state.chatVisible)
      ? await loadVideo(chatUrl).catch(() => null)
      : null;

    const imgSrc = state.imgSrc;
    const imgObj = (imgSrc && state.imageVisible)
      ? await loadImage(imgSrc).catch(() => null)
      : null;

          // ── Watermark ─────────────────────────────────────────────────────────────
    const wmEl      = document.querySelector('#watermark_video');
    const wmSrc     = wmEl?.currentSrc || wmEl?.src || wmEl?.querySelector('source')?.src || '';
    const wmOpacity = wmEl ? (parseFloat(getComputedStyle(wmEl).opacity) || 1) : 1;
    const wmVid = (wmSrc && state.watermarkVisible !== false)
    ? await new Promise(res => {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.preload    = 'auto';
        v.playsInline = true;
        v.muted      = true;
        v.src        = wmSrc; // no cache-bust — watermark never changes, let browser cache it
        const done = () => res(v);
        const fail = () => res(null);
        const t    = setTimeout(fail, 8000);
        v.addEventListener('canplay', () => { clearTimeout(t); done(); }, { once: true });
        v.addEventListener('error',   () => { clearTimeout(t); fail(); }, { once: true });
        v.load();
      }).catch(() => null)
    : null;
  if (wmVid) wmVid.loop = true;

// ── Source badge ──────────────────────────────────────────────────────────
const barEl    = [...document.querySelectorAll('#source_badge > div')]
  .find(el => getComputedStyle(el).display !== 'none');
const imgEl    = barEl?.querySelector('img');
const logoSrc  = imgEl?.currentSrc || imgEl?.src || '';
const txtEl = [...(barEl?.children || [])]
  .find(el => el.tagName !== 'IMG' && !el.classList.contains('behind') && getComputedStyle(el).position !== 'absolute');
  const innerTxtEl  = [...(txtEl?.children || [])]
  .find(el => !el.classList.contains('behind') && getComputedStyle(el).position !== 'absolute');
const innerBehind = [...(txtEl?.children || [])]
  .find(el => el.classList.contains('behind'));
const badgeText = (() => {
  if (!txtEl) return '';
  return [...txtEl.childNodes]
    .filter(n => !(n.nodeType === 1 && n.classList?.contains('behind')))
    .map(n => n.textContent)
    .join('').trim();
})();
const kickLogo  = (state.sourceBadgeVisible !== false && badgeText && logoSrc)
  ? await loadImage(logoSrc).catch(() => null)
  : null;

let badgeLayout = null;
if (kickLogo && barEl) {
  const cW    = frame.clientWidth;
  const cH    = frame.clientHeight;
  const SF_W  = OUT_W / cW;
  const SF_H  = OUT_H / cH;
  const cRect = frame.getBoundingClientRect();
  const bR    = barEl.getBoundingClientRect();
  const lR    = imgEl?.getBoundingClientRect();
  const tR    = txtEl?.getBoundingClientRect();
  if (bR) {
    badgeLayout = {
      barY:       (bR.top  - cRect.top)  * SF_H,
      barH:       bR.height * SF_H,
      barBg:      (() => { const bg = getComputedStyle(barEl).backgroundColor; return (bg && bg !== 'rgba(0, 0, 0, 0)') ? bg : '#000000'; })(),
      logoX:      lR ? (lR.left - cRect.left) * SF_W : 0,
      logoY:      lR ? (lR.top  - cRect.top)  * SF_H : 0,
      logoW:      lR ? lR.width  * SF_W : 0,
      logoH:      lR ? lR.height * SF_H : 0,
      textX:      tR ? (tR.right - cRect.left) * SF_W : OUT_W,
      textY:      tR ? (tR.top - cRect.top + tR.height / 2) * SF_H : 0,
      textSize:          tR ? parseFloat(getComputedStyle(innerTxtEl || txtEl).fontSize) * SF_H : 28,
      textWeight:        getComputedStyle(innerTxtEl || txtEl).fontWeight || '700',
      textFamily:        getComputedStyle(innerTxtEl || txtEl).fontFamily || 'Inter, sans-serif',
      textColor:         getComputedStyle(innerTxtEl || txtEl).color || '#ffffff',
      letterSpacing: `${parseFloat(getComputedStyle(innerTxtEl || txtEl).letterSpacing || '0') * SF_H}px`,
      textStrokeW:       parseFloat(getComputedStyle(innerTxtEl || txtEl).webkitTextStrokeWidth) * SF_H || 0,
      textStrokeColor:   getComputedStyle(innerTxtEl || txtEl).webkitTextStrokeColor || 'transparent',
      behindStrokeW:     innerBehind ? parseFloat(getComputedStyle(innerBehind).webkitTextStrokeWidth) * SF_H || 0 : 0,
      behindStrokeColor: innerBehind ? getComputedStyle(innerBehind).webkitTextStrokeColor || 'transparent' : 'transparent',
    };
  }
}


    // ── 2. Snapshot text styles from live DOM at render resolution ────────────
    const editorW = frame.clientWidth || 1;
    const SF      = OUT_W / editorW;
    const ts      = snapshotTextLayout(SF);

    // ── 3. Output canvases ────────────────────────────────────────────────────
    const rc       = document.createElement('canvas');
    rc.width       = OUT_W;
    rc.height      = OUT_H;
    const ctx      = rc.getContext('2d');

    const TW            = QUALITY_PRESETS[THUMB_EXPORT_PRESET].w;
    const TH            = QUALITY_PRESETS[THUMB_EXPORT_PRESET].h;
    const thumbC        = document.createElement('canvas');
    thumbC.width        = TW;
    thumbC.height       = TH;
    const thumbCtx      = thumbC.getContext('2d');
    const blurCanvas    = document.createElement('canvas');
    const blurCtx       = blurCanvas.getContext('2d');
    const chatFrameCanvas = document.createElement('canvas');
    const chatFrameCtx  = chatFrameCanvas.getContext('2d');

    let drawFrameIndex = 0;
    let thumbJpegBlob  = null;

    // ── 4. Encoding setup ─────────────────────────────────────────────────────
    console.log('Render: [2] checking MP4 support…');
    const webCodecsMp4Ok = await ensureMp4Support();

    // Use Mediabunny (WebCodecs H.264) when available AND either:
    //   a) AudioEncoder exists → full H.264 + AAC encode, or
    //   b) We're on iOS       → video-only Mediabunny + raw-AAC remux for audio.
    // Desktop browsers with VideoEncoder but without AudioEncoder are rare;
    // they fall through to the MediaRecorder path which handles audio natively.
    const useMp4 = webCodecsMp4Ok && (typeof AudioEncoder !== 'undefined' || _isIOS || _isChromeIOS) && effectiveStart === 0;
    const _noAudioIOS = _isIOS && typeof AudioEncoder === 'undefined';

    console.log('Render: [3] encoding —',
      'useMp4:', useMp4,
      _isIOS       ? '(iOS)'                                            : '',
      _isChromeIOS ? '(Chrome iOS, raw-AAC remux)'
                   : _noAudioIOS ? '(Safari iOS no AudioEncoder, raw-AAC remux)' : '',
      typeof AudioEncoder !== 'undefined'                     ? 'AudioEncoder:yes' : 'AudioEncoder:no',
      typeof rv.requestVideoFrameCallback === 'function'      ? 'rVFC:yes'         : 'rVFC:no');

    // ── 5. Encoder / recorder initialisation ──────────────────────────────────
    let audioCtx           = null;
    let output             = null;
    let videoSource        = null;
    let audioSource        = null;
    let recorder           = null;
    let chunks             = null;
    let outputStarted      = false;
    let startMp4Output     = null;
    let setupMp4AudioSource = null;
    let mp4AudioBuffer     = null;
    let mp4AudioAddPromise = null;   // ← awaited in finishMp4 before audioSource.close()
    let rawAudioData       = null;
    let _rawAudioPromise   = null;
    let _extractAbort      = null;

    if (useMp4) {
      const {
        Output, Mp4OutputFormat, BufferTarget,
        CanvasSource, AudioBufferSource: MBAudioBufferSource,
      } = _mb;

      const createVideoSource = () => new CanvasSource(rc, { codec: 'avc', bitrate: 8_000_000 });

      try {
        audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') {
          await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
        }
      } catch (_) {
        console.warn('Render: AudioContext creation failed — video-only output');
      }

      // Prepare the audio source for Mediabunny.
      // • With AudioEncoder (desktop / modern iOS): fetch the source file, decode
      //   PCM, trim to the clip window, and store as an AudioBufferSource.
      // • Without AudioEncoder (older iOS): fire raw-AAC extraction in the
      //   background and return immediately so the render loop can start without
      //   blocking on a potentially large source-file fetch.
      setupMp4AudioSource = async () => {
        if (!audioCtx || audioSource) return;

        if (typeof AudioEncoder === 'undefined') {
          // iOS no-AudioEncoder path. Fire extraction in background — do NOT await
          // here. Source files can be 100–300 MB; blocking here would stall the
          // render progress bar at 0% for the entire fetch duration.
          // finishMp4 awaits _rawAudioPromise (with a 20 s timeout) before remux.
          if (_isIOS && !_rawAudioPromise) {
            _extractAbort    = new AbortController();
            _rawAudioPromise = extractRawMp4Audio(
              gpVideo.currentSrc || gpVideo.src,
              effectiveStart, effectiveEnd,
              _extractAbort.signal
            ).then(data => {
              rawAudioData = data;
              console.log('Render: raw AAC extracted —',
                rawAudioData ? rawAudioData.samples.length + ' samples' : 'no audio track found');
            }).catch(e => {
              console.warn('Render: raw audio extraction failed (video-only fallback):', e);
            });
          }
          if (state.musicUrl) {
            console.warn('Render: music mixing skipped — AudioEncoder unavailable on this platform (iOS)');
          }
          return;
        }

        if (audioCtx.state === 'suspended') {
          await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
        }

        try {
          const audioRes = await fetch(gpVideo.currentSrc || gpVideo.src, { cache: 'no-store' });
          if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
          let rawBytes   = await audioRes.arrayBuffer();
          let fullPcm    = await audioCtx.decodeAudioData(rawBytes);
          rawBytes       = null;
          const clipBuffer = trimAudioBuffer(audioCtx, fullPcm, effectiveStart, effectiveEnd);
          fullPcm          = null;
        
          // ── Music mixing ────────────────────────────────────────────────────────
          let musicBuffer = null;
          if (state.musicUrl) {
            try {
              const musicRes = await fetch(state.musicUrl, { cache: 'no-store' });
              if (musicRes.ok) {
                let musicBytes = await musicRes.arrayBuffer();
                musicBuffer    = await audioCtx.decodeAudioData(musicBytes);
                musicBytes     = null;
                console.log('Render: music decoded —', state.musicUrl);
              }
            } catch (e) {
              console.warn('Render: music fetch/decode failed — clip audio only:', e.message);
            }
          }
        
          mp4AudioBuffer = mixAudioBuffers(
            audioCtx,
            clipBuffer,
            state.clipVolume  ?? 1.0,
            state.musicMuted ? null : musicBuffer,  // ← pass null if muted
            state.musicVolume ?? 0.8,
            state.musicOffset ?? 0,
            tracks.music?.start ?? 0,
            tracks.music?.end   ?? totalDuration,
            effectiveStart
          );
        
          audioSource = new MBAudioBufferSource({ codec: 'aac', bitrate: 128_000 });
        } catch (e) {
          console.warn('Render: audio fetch/decode failed (CORS or network) — video-only:', e.message);
          audioSource = null;
        }
      };

      // Pre-load audio before the render loop when AudioEncoder is available.
      // On iOS without AudioEncoder, extraction fires lazily from the seeked handler.
      if (typeof AudioEncoder !== 'undefined') {
        await setupMp4AudioSource();
      }

      startMp4Output = async () => {
        if (outputStarted) return;
        console.log('Render: [4] creating Mediabunny output…');
        videoSource = createVideoSource();
        output = new Output({
          // fastStart: false writes moov at the end of the file, avoiding the
          // 2× memory spike of an in-memory reorder at finalize time.
          // TikTok and all major platforms handle non-fast-start MP4 correctly.
          format: new Mp4OutputFormat({ fastStart: false }),
          target: new BufferTarget(),
        });
        output.addVideoTrack(videoSource, { frameRate: FPS });
        if (audioSource) output.addAudioTrack(audioSource);
        await Promise.race([
          output.start(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('MP4 output.start() timed out after 6 s')), 6000)
          ),
        ]);
        outputStarted = true;
        // Kick off AAC encoding. The returned promise is stored and MUST be
        // awaited in finishMp4 before audioSource.close() is called — failing
        // to do so interrupts in-flight encoding and causes the muxer to write
        // the final audio batch with incorrect timestamps, producing the
        // lip-sync drift observed near the end of the rendered clip.
        if (audioSource && mp4AudioBuffer) {
          mp4AudioAddPromise = audioSource.add(mp4AudioBuffer);
        }
        console.log('Render: [5] output started');
      };

    } else {
      // ── MediaRecorder fallback ────────────────────────────────────────────
      // Used on desktop browsers that have VideoEncoder but lack AudioEncoder,
      // and as a last-resort for any platform without WebCodecs at all.
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
        console.warn('Render: audio routing failed — video-only MediaRecorder output');
      }

      const mimeCandidates = _isIOS
        ? [
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4;codecs=h264,aac',
            'video/mp4',
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
          ]
        : [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4',
            'video/webm',
          ];
      const mimeType = getSupportedMimeType(mimeCandidates);
      if (!mimeType) throw new Error('No supported recording format on this browser');
      console.log('Render: MediaRecorder mimeType', mimeType);

      const recOpts = { mimeType, videoBitsPerSecond: 8_000_000 };
      if (mimeType.includes('webm')) recOpts.audioBitsPerSecond = 128_000;
      try {
        recorder = new MediaRecorder(stream, recOpts);
      } catch (_) {
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      }
      chunks = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    }

    // ── 6. Layout computation ─────────────────────────────────────────────────
    const mode    = state.mode;
    const gpHoldH = mode === 'is-split' ? OUT_H * state.splitPct : OUT_H;
    const fcHoldH = mode === 'is-split' ? OUT_H - gpHoldH : 0;

    const vw = rv.videoWidth, vh = rv.videoHeight;

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
    const panCX    = (editorL + editorDW / 2) / editorHW;
    const panCY    = (editorT + editorDH / 2) / editorHH;

    const gpL = dw > OUT_W
      ? Math.max(OUT_W - dw, Math.min(0, panCX * OUT_W - dw / 2))
      : (OUT_W - dw) / 2;
    const gpT = dh > gpHoldH
      ? Math.max(gpHoldH - dh, Math.min(0, panCY * gpHoldH - dh / 2))
      : (gpHoldH - dh) / 2;

    // Facecam crop
    const hasFacecam = state.facecamVisible && document.querySelector(
      '[wized="stream_clip_contains_facecam"]'
    )?.textContent.trim().toLowerCase() === 'true';

    let fcCrop = null;
    if (hasFacecam) {
      const x1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x1"]')?.textContent);
      const y1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y1"]')?.textContent);
      const x2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x2"]')?.textContent);
      const y2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y2"]')?.textContent);
      if ([x1, y1, x2, y2].every(isFinite) && x2 > x1 && y2 > y1) fcCrop = { x1, y1, x2, y2 };
    }

    // Image layout
    let imgLayout = null;
    if (imgObj && state.imageVisible) {
      const iw  = state.imageScale * OUT_W;
      const ih  = iw * (imgObj.naturalHeight / imgObj.naturalWidth);
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

    // Title word-wrap
    let titleLines = [];
    if (state.title) {
      const font = `${ts.tFontWeight} ${ts.tFontSize}px ${ts.tFontFamily}`;
      const mCtx = document.createElement('canvas').getContext('2d');
      mCtx.font  = font;
      const wrapW = OUT_W - ts.padLeft - ts.padRight - ts.tPillPadLeft - ts.tPillPadRight;
      let current = '';
      for (const word of state.title.split(' ')) {
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

    // Subtitle transcript
    let transcript = null;
    let subChunks  = null;
    const CHUNK_SIZE = 3;
    const subMode    = document.querySelector('.subtitle_hold')?.dataset.subtitleMode ?? 'word';
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

    // ── 7. Frame timer ────────────────────────────────────────────────────────
    // Worker setInterval gives the most accurate pacing on desktop.
    // Blob-URL Workers are unreliable in iOS/iPadOS WebKit and on desktop Safari,
    // so those platforms use an in-thread setInterval instead.
    console.log('Render: [6] setting up frame timer…');
    const _skipWorkerTimer  = _isIOS || _isSafariDesktop;
    let _useWorkerTimer     = false;
    let _timerWorker        = null;
    let _timerUrl           = null;
    let _timerInterval      = null;
    let _rvfcHandle         = null;
    let _rvfcGuardInterval  = null;

    if (!_skipWorkerTimer) {
      try {
        const blob  = new Blob([`
          let iv;
          self.onmessage = e => {
            if (e.data === 'start') { clearInterval(iv); iv = setInterval(() => self.postMessage(0), ${Math.round(1000 / FPS)}); }
            else if (e.data === 'stop') { clearInterval(iv); }
          };
        `], { type: 'application/javascript' });
        _timerUrl       = URL.createObjectURL(blob);
        _timerWorker    = new Worker(_timerUrl);
        _useWorkerTimer = true;
      } catch (_) {
        _useWorkerTimer = false;
      }
    }

    if (!_useWorkerTimer) {
      console.log('Render: in-thread setInterval timer'
        + (_isIOS           ? ' (iOS)'            : '')
        + (_isSafariDesktop ? ' (Safari desktop)' : ''));
    }

    // ── 8. Render promise ─────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {

      function cleanup() {
        frame._rendering = false;
        if (_rvfcHandle != null && typeof rv.cancelVideoFrameCallback === 'function') {
          try { rv.cancelVideoFrameCallback(_rvfcHandle); } catch (_) {}
          _rvfcHandle = null;
        }
        if (_rvfcGuardInterval) { clearInterval(_rvfcGuardInterval); _rvfcGuardInterval = null; }
        if (_useWorkerTimer && _timerWorker) {
          _timerWorker.postMessage('stop');
          _timerWorker.terminate();
          if (_timerUrl) URL.revokeObjectURL(_timerUrl);
        } else if (_timerInterval) {
          clearInterval(_timerInterval);
        }
        rv.pause();
        gpVideo.pause();
        gpVideo.muted = _gpWasMuted;
        if (chatVid) chatVid.pause();
        rv.removeAttribute('src'); rv.load();
        try { rv.parentNode?.removeChild(rv); } catch (_) {}
        if (chatVid) { chatVid.removeAttribute('src'); chatVid.load(); }
        if (wmVid)   { wmVid.pause(); wmVid.removeAttribute('src'); wmVid.load(); }
        blurCanvas.width      = 0; blurCanvas.height      = 0;
        chatFrameCanvas.width = 0; chatFrameCanvas.height = 0;
        if (audioCtx) audioCtx.close().catch(() => {});
      }

      async function finishMp4() {
        console.log('Render: finishMp4 called');
        try {
          if (!outputStarted || !videoSource || !output) {
            console.warn('Render: finishMp4 guard failed',
              { outputStarted, hasVS: !!videoSource, hasOut: !!output });
            throw new Error('MP4 output was not started');
          }

          // Flush the H.264 encoder. The last video frame was submitted without
          // awaiting (Mediabunny backpressure deadlock on final frame) — close()
          // drains it as part of the encoder shutdown sequence.
          console.log('Render: closing videoSource…');
          try { videoSource.close(); }
          catch (e) { console.error('Render: videoSource.close() threw:', e); throw e; }

          // Wait for all AAC frames to finish encoding BEFORE closing the audio
          // encoder. Without this await, close() interrupts in-flight PCM→AAC
          // encoding and the muxer writes the final batch with corrupt timestamps,
          // producing the lip-sync drift visible near the end of the clip.
          if (mp4AudioAddPromise) {
            console.log('Render: awaiting audio encode completion…');
            try { await mp4AudioAddPromise; }
            catch (e) { console.warn('Render: audio encode promise rejected:', e); }
          }

          console.log('Render: closing audioSource…');
          try { if (audioSource) audioSource.close(); }
          catch (e) { console.error('Render: audioSource.close() threw:', e); throw e; }

          mp4AudioBuffer = null;

          // iOS no-AudioEncoder: wait for the background raw-AAC extraction.
          // Race against 20 s — if the source MP4 moov is at end-of-file or the
          // connection is slow, abort and fall back gracefully to video-only.
          if (_rawAudioPromise) {
            console.log('Render: awaiting raw AAC extraction…');
            await Promise.race([
              _rawAudioPromise,
              new Promise(r => setTimeout(() => {
                console.warn('Render: audio extraction timed out — video-only fallback');
                _extractAbort?.abort();
                r();
              }, 20_000)),
            ]);
            _rawAudioPromise = null;
            _extractAbort    = null;
          }

          console.log('Render: calling output.finalize()…');
          await output.finalize();
          console.log('Render: finalize complete —',
            (output.target.buffer?.byteLength ?? 0) / 1048576 | 0, 'MB');

          let finalBuffer = output.target.buffer;
          if (rawAudioData && _mbMp4) {
            try {
              console.log('Render: remuxing', rawAudioData.samples.length, 'raw AAC samples…');
              finalBuffer = await remuxWithAudio(finalBuffer, rawAudioData);
              console.log('Render: remux complete —',
                (finalBuffer.byteLength / 1048576).toFixed(1), 'MB');
            } catch (e) {
              console.warn('Render: audio remux failed — video-only:', e);
            }
            rawAudioData = null;
          }

          cleanup();
          resolve({ video: new Blob([finalBuffer], { type: 'video/mp4' }), thumb: thumbJpegBlob });
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
        resolve({ video: videoBlob, thumb: thumbJpegBlob });
      }

      if (!useMp4) {
        recorder.onstop = finishRecorder;
        recorder.addEventListener('dataavailable', () => {
          if (recorder.state === 'inactive') finishRecorder();
        });
        recorder.onerror = e => {
          if (!_recorderResolved) { _recorderResolved = true; cleanup(); reject(e); }
        };
      }

      // ── Decoder prime + seek ────────────────────────────────────────────────
      // Seek 2 frames before effectiveStart then seek to the exact start.
      // This warms up the decode pipeline on hardware that lazy-initialises on
      // first seek, preventing frozen or black first frames in the output.
      const prerollDuration = 2 / FPS;
      const prerollStart    = Math.max(0, effectiveStart - prerollDuration);
      let primedExactStart  = Math.abs(prerollStart - effectiveStart) < 0.0001;

      console.log('Render: seeking to preroll', prerollStart.toFixed(3));
      rv.currentTime      = prerollStart;
      gpVideo.currentTime = prerollStart;
      if (chatVid) chatVid.currentTime = prerollStart;

      rv.addEventListener('seeked', async function onSeeked() {
        rv.removeEventListener('seeked', onSeeked);

        if (!primedExactStart) {
          primedExactStart    = true;
          rv.currentTime      = effectiveStart;
          gpVideo.currentTime = effectiveStart;
          if (chatVid) chatVid.currentTime = effectiveStart;
          console.log('Render: decoder primed, seeking to', effectiveStart.toFixed(3));
          rv.addEventListener('seeked', onSeeked, { once: true });
          return;
        }

        console.log('Render: seeked — starting playback…');
        try {
          await rv.play();
          console.log('Render: play resolved — time:', rv.currentTime.toFixed(3));
          // In the buffered-audio MP4 path, rv stays muted — audio comes from
          // the pre-decoded mp4AudioBuffer via Mediabunny, not from rv's live output.
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
        } catch (e) {
          console.error('Render: play failed', e);
          cleanup();
          reject(e);
          return;
        }

        // In the Mediabunny path rv is never played — frame timing is driven by
        // the seek loop. Only play gpVideo (and start the recorder) for MediaRecorder,
        // where gpVideo's rVFC is still needed for timing.
        if (!useMp4) {
          gpVideo.play().catch(() => {});
          if (chatVid) { chatVid.muted = true; chatVid.play().catch(() => {}); }
          recorder.start(100);
        } else {
          if (chatVid) chatVid.pause();
        }

        // ── drawCanvasFrame ─────────────────────────────────────────────────
        // Composites all layers at logical time t (seconds from clip start).
        // t is deterministic (effectiveStart + index/FPS); rv is force-synced
        // to t in pumpEmits to ensure pixel content matches the timestamp.
        function drawCanvasFrame(t) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, OUT_W, OUT_H);

          // Layer 1 — blurred backdrop (full / overlay modes only)
          if (mode !== 'is-split') {
            drawBackdropFrame(ctx, rv, vw, vh, OUT_W, OUT_H, blurCanvas, blurCtx);
          }

          // Layer 2 — gameplay video
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, OUT_W, gpHoldH);
          ctx.clip();
          ctx.drawImage(rv, 0, 0, vw, vh, gpL, gpT, dw, dh);
          ctx.restore();

          // Layer 3 — facecam
          if (fcCrop && hasFacecam) {
            const srcX = fcCrop.x1 * vw, srcY = fcCrop.y1 * vh;
            const srcW = (fcCrop.x2 - fcCrop.x1) * vw;
            const srcH = (fcCrop.y2 - fcCrop.y1) * vh;

            if (mode === 'is-split') {
              const fcScale = Math.max(OUT_W / srcW, fcHoldH / srcH);
              const fcDW    = srcW * fcScale, fcDH = srcH * fcScale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(0, gpHoldH, OUT_W, fcHoldH);
              ctx.clip();
              ctx.drawImage(rv, srcX, srcY, srcW, srcH,
                (OUT_W - fcDW) / 2, gpHoldH + (fcHoldH - fcDH) / 2, fcDW, fcDH);
              ctx.restore();
            } else if (mode === 'is-overlay') {
              const olW = state.facecamW * OUT_W, olH = state.facecamH * OUT_H;
              const olX = state.facecamX * OUT_W - olW / 2;
              const olY = state.facecamY * OUT_H - olH / 2;
              const fcScale = Math.max(olW / srcW, olH / srcH);
              const fcDW    = srcW * fcScale, fcDH = srcH * fcScale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(olX, olY, olW, olH);
              ctx.clip();
              ctx.drawImage(rv, srcX, srcY, srcW, srcH,
                olX + (olW - fcDW) / 2, olY + (olH - fcDH) / 2, fcDW, fcDH);
              ctx.restore();
            }
          }

          // Layer 4 — image overlay
          if (imgLayout && state.imageVisible) {
            const imgStart = tracks.image?.start ?? 0;
            const imgEnd   = tracks.image?.end   ?? duration;
            if (t >= imgStart && t <= imgEnd) {
              ctx.drawImage(imgObj, imgLayout.x, imgLayout.y, imgLayout.w, imgLayout.h);
            }
          }

          // Layer 5 — chat overlay
          if (chatVid && chatLayout && state.chatVisible) {
            ctx.save();
            const blend = state.chatBlend || 'screen';
            ctx.globalCompositeOperation = blend === 'normal' ? 'source-over' : blend;
            const chatFrameW = Math.max(1, Math.round(chatLayout.w));
            const chatFrameH = Math.max(1, Math.round(chatLayout.h));
            if (chatFrameCanvas.width  !== chatFrameW) chatFrameCanvas.width  = chatFrameW;
            if (chatFrameCanvas.height !== chatFrameH) chatFrameCanvas.height = chatFrameH;
            chatFrameCtx.save();
            chatFrameCtx.setTransform(1, 0, 0, 1, 0, 0);
            chatFrameCtx.globalCompositeOperation = 'source-over';
            chatFrameCtx.clearRect(0, 0, chatFrameW, chatFrameH);
            chatFrameCtx.drawImage(chatVid, 0, 0, chatFrameW, chatFrameH);
            chatFrameCtx.restore();
            ctx.drawImage(chatFrameCanvas, chatLayout.x, chatLayout.y, chatLayout.w, chatLayout.h);
            ctx.globalCompositeOperation = 'source-over';
            ctx.restore();
          }

          // Layers 6 & 7 — title + subtitle text
          {
            const tl     = api.getTextLayout();
            const titleY = (tl.titleY ?? 0) * OUT_H;
            const subY   = (tl.subY   ?? 0) * OUT_H;

            if (titleLines.length && state.titleVisible) {
              const titleStart = tracks.title?.start ?? 0;
              const titleEnd   = tracks.title?.end   ?? duration;
              if (t >= titleStart && t <= titleEnd) renderTitleAtY(ctx, titleLines, titleY, ts);
            }

            if (transcript && state.subtitleVisible) {
              const ms = t * 1000;
              if (subMode === 'chunk' && subChunks) {
                let foundChunk = -1, foundWord = -1;
                outer: for (let ci = 0; ci < subChunks.length; ci++) {
                  for (let wi = 0; wi < subChunks[ci].length; wi++) {
                    const w = subChunks[ci][wi];
                    if (ms >= w.start && ms < w.end) { foundChunk = ci; foundWord = wi; break outer; }
                  }
                }
                if (foundChunk !== -1) renderSubChunkAtY(ctx, subChunks[foundChunk], foundWord, subY, ts);
              } else {
                const word = transcript.find(w => ms >= w.start && ms < w.end);
                if (word) renderSubWordAtY(ctx, word.text, subY, ts);
              }
            }
          }

           // Layer 8 — watermark
           if (wmVid) {
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            if (wmOpacity < 1) ctx.globalAlpha = wmOpacity;
            ctx.drawImage(wmVid, 0, 0, OUT_W, OUT_H);
            ctx.restore();
           }

          // Layer 9 — source badge
          if (kickLogo && badgeLayout) {
            ctx.save();
            ctx.fillStyle = badgeLayout.barBg;
            ctx.fillRect(0, badgeLayout.barY, OUT_W, badgeLayout.barH);
            ctx.drawImage(kickLogo, badgeLayout.logoX, badgeLayout.logoY, badgeLayout.logoW, badgeLayout.logoH);
            ctx.font = `${badgeLayout.textWeight} ${badgeLayout.textSize}px ${badgeLayout.textFamily}`;
            ctx.letterSpacing = badgeLayout.letterSpacing;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'right';
            ctx.lineJoin = 'round';
            if (badgeLayout.behindStrokeW > 0) {
              ctx.lineWidth   = badgeLayout.behindStrokeW;
              ctx.strokeStyle = badgeLayout.behindStrokeColor;
              ctx.strokeText(badgeText, badgeLayout.textX, badgeLayout.textY);
            }
            if (badgeLayout.textStrokeW > 0) {
              ctx.lineWidth   = badgeLayout.textStrokeW;
              ctx.strokeStyle = badgeLayout.textStrokeColor;
              ctx.strokeText(badgeText, badgeLayout.textX, badgeLayout.textY);
            }
            ctx.fillStyle = badgeLayout.textColor;
            ctx.fillText(badgeText, badgeLayout.textX, badgeLayout.textY);
            ctx.restore();
          }
        }

        // ── Frame capture loop ──────────────────────────────────────────────
        // Output is strict 30fps CFR. Frames are encoded at deterministic
        // timestamps (index/FPS). emitFrameAt pauses rv and awaits its seek
        // before drawing so pixel content always matches the declared timestamp.
        const totalFrames  = Math.max(1, Math.round(totalDuration * FPS));
        let nextEmitIndex  = 0;
        let renderFinished = false;

        // All Mediabunny paths (desktop + iOS) use seek-based frame capture.
        //
        // The rVFC + play/pause approach was designed for MediaRecorder, where rv
        // must play continuously for live audio routing. In the Mediabunny path,
        // audio comes from the pre-decoded mp4AudioBuffer — rv never needs to play.
        // Each `await rv.play()` takes 30-50 ms (browser pipeline + compositor
        // registration). Over 1800 frames that's ~72 s added to the render time.
        //
        // Seeking a paused, buffered video element costs 5-15 ms per frame —
        // far cheaper. rVFC is kept only for the MediaRecorder path (useMp4=false)
        // where rv must play for audio. iOS-specific play() unreliability is moot
        // here since we never call play() in this path at all.
        const _iosSeekMode = useMp4;
        // Activated when the rVFC watchdog triggers the seek-based fallback.
        let _timerSeekMode = false;

        async function emitFrameAt(index) {
          const t = effectiveStart + (index / FPS);

          if (useMp4 && !_iosSeekMode && !_timerSeekMode) {
            // Pause rv BEFORE drawing, then await the seek if rv has drifted.
            //
            // The original order was: draw → pause → encode → play. This was
            // wrong: rv is playing between frames (freed by the previous frame's
            // rv.play()), so by the time drawCanvasFrame runs, rv has advanced
            // past the intended timestamp. pumpEmits corrected this with a
            // non-awaited rv.currentTime setter, but a non-awaited seek means
            // drawCanvasFrame still captures stale pixels — the seek resolves
            // AFTER the draw. When pumpEmits batches many frames (common near
            // the end of a long clip as encoder backpressure grows), every frame
            // in the batch draws from rv's previous position. The encoded frames
            // carry correct timestamps but wrong pixel content: video appears to
            // play in slow motion because consecutive frames show nearly identical
            // content from earlier in the clip.
            //
            // Correct order: pause → await seek if needed → draw → encode → play.
            rv.pause();
            if (chatVid) chatVid.pause();
            if (Math.abs(rv.currentTime - t) > 0.002) {
              await new Promise(res => {
                rv.addEventListener('seeked', res, { once: true });
                rv.currentTime = t;
              });
              if (chatVid) chatVid.currentTime = t;
            }
          }

          if (wmVid && wmVid.duration > 0) wmVid.currentTime = (index / FPS) % wmVid.duration;
          drawCanvasFrame(t);

          if (drawFrameIndex === THUMB_FRAME_INDEX) {
            try {
              thumbCtx.drawImage(rc, 0, 0, TW, TH);
              thumbJpegBlob = _jpegBlobFromCanvas(thumbC, 0.88);
            } catch (e) { console.warn('Render: thumbnail capture failed', e); }
          }
          drawFrameIndex++;

          if (useMp4) {
            const isLastFrame = (index + 1) >= totalFrames;
            if (isLastFrame) {
              // Do NOT await the last frame — Mediabunny's backpressure only
              // resolves when ready for the NEXT frame. Awaiting here deadlocks.
              // videoSource.close() in finishMp4 drains this final frame.
              videoSource.add(index / FPS, 1 / FPS);
            } else {
              await videoSource.add(index / FPS, 1 / FPS);
              if (!_iosSeekMode && !_timerSeekMode && !rv.ended) {
                try { await rv.play(); } catch (_) {}
                if (chatVid && !chatVid.ended) { try { await chatVid.play(); } catch (_) {} }
              }
            }
          }

          onProgress?.(Math.min(1, Math.max(0, (index + 1) / totalFrames)));
        }

        async function pumpEmits(currentMediaTime) {
          const offset = currentMediaTime - effectiveStart;
          while (nextEmitIndex < totalFrames && (nextEmitIndex / FPS) <= offset + 1e-6) {
            await emitFrameAt(nextEmitIndex);
            nextEmitIndex++;
          }
        }

        async function finalizeRender() {
          if (renderFinished) return;
          renderFinished = true;
          console.log('Render: finalizeRender — emitted', nextEmitIndex, '/', totalFrames);

          if (_useWorkerTimer && _timerWorker) _timerWorker.postMessage('stop');
          else if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
          if (_rvfcHandle != null && typeof rv.cancelVideoFrameCallback === 'function') {
            try { rv.cancelVideoFrameCallback(_rvfcHandle); } catch (_) {}
            _rvfcHandle = null;
          }
          if (_rvfcGuardInterval) { clearInterval(_rvfcGuardInterval); _rvfcGuardInterval = null; }

          // Pad remaining frames (rv ended early, rVFC stalled, etc.)
          while (nextEmitIndex < totalFrames) {
            await emitFrameAt(nextEmitIndex);
            nextEmitIndex++;
          }

          rv.pause();
          gpVideo.pause();
          if (chatVid) chatVid.pause();

          if (useMp4) {
            finishMp4();
          } else {
            setTimeout(() => {
              try { if (recorder.state === 'recording') recorder.requestData(); } catch (_) {}
              try { recorder.stop(); } catch (_) {}
              setTimeout(finishRecorder, 2000);
            }, 150);
          }
        }

        const _hasVFC = typeof rv.requestVideoFrameCallback === 'function';

        if (_iosSeekMode) {
          // ── iOS: frame-by-frame seek loop ───────────────────────────────
          rv.pause();
          if (chatVid) chatVid.pause();
          console.log('Render: seek-based capture — totalFrames:', totalFrames,
            _isIOS ? '(iOS)' : '(desktop Mediabunny)');
          (async () => {
            try {
              for (let i = 0; i < totalFrames; i++) {
                const t = effectiveStart + i / FPS;
                if (Math.abs(rv.currentTime - t) >= 0.001) {
                  await new Promise(res => {
                    rv.addEventListener('seeked', res, { once: true });
                    rv.currentTime = t;
                  });
                }
                if (chatVid) chatVid.currentTime = t;
                await emitFrameAt(i);
                nextEmitIndex = i + 1;
              }
              finalizeRender();
            } catch (e) { cleanup(); reject(e); }
          })();

        } else if (_hasVFC) {
          // ── rVFC path (desktop / non-iOS) ───────────────────────────────
          console.log('Render: using requestVideoFrameCallback');
          let _lastPumpPromise = Promise.resolve();
          let _lastRvfcFiredAt = Date.now();
          let _rvfcEverFired   = false;

          // Watchdog: rVFC won't fire if rv is off-compositor (e.g. inside a
          // display:none ancestor). Fall back to seek-based timer loop after 2 s.
          const _rvfcWatchdog = setTimeout(() => {
            if (!_rvfcEverFired && !renderFinished) {
              console.warn('Render: rVFC not firing — switching to timer loop');
              if (_rvfcHandle != null) {
                try { rv.cancelVideoFrameCallback(_rvfcHandle); } catch (_) {}
                _rvfcHandle = null;
              }
              startTimerLoop();
            }
          }, 2000);

          // Guard: rVFC stops firing when the video ends naturally. Catch this
          // and finalize rather than waiting indefinitely.
          _rvfcGuardInterval = setInterval(async () => {
            if (renderFinished) { clearInterval(_rvfcGuardInterval); _rvfcGuardInterval = null; return; }
            if (_rvfcEverFired && gpVideo.ended && (Date.now() - _lastRvfcFiredAt) > 500) {
              clearInterval(_rvfcGuardInterval); _rvfcGuardInterval = null;
              await _lastPumpPromise;
              finalizeRender();
            }
          }, 200);

          const onVideoFrame = async (now, metadata) => {
            if (!frame._rendering || renderFinished) return;
            if (!_rvfcEverFired) { _rvfcEverFired = true; clearTimeout(_rvfcWatchdog); }
            _lastRvfcFiredAt = Date.now();
            await (_lastPumpPromise = pumpEmits(metadata.mediaTime));
            if (nextEmitIndex >= totalFrames || metadata.mediaTime >= effectiveEnd - 0.001 || gpVideo.ended) {
              finalizeRender();
              return;
            }
            // Re-arm after pumpEmits resolves — naturally paces to encoder throughput,
            // preventing frame-backlog build-up under encoder backpressure.
            _rvfcHandle = gpVideo.requestVideoFrameCallback(onVideoFrame);
          };
          _rvfcHandle = gpVideo.requestVideoFrameCallback(onVideoFrame);

        } else {
          // ── Timer fallback ──────────────────────────────────────────────
          console.warn('Render: rVFC unavailable — timer loop');
          startTimerLoop();
        }

        function startTimerLoop() {
          // Seek-based loop: immune to external code re-pausing rv mid-render.
          _timerSeekMode = true;
          rv.pause();
          if (chatVid) chatVid.pause();
          console.log('Render: [timer] seek loop — totalFrames:', totalFrames);
          (async () => {
            try {
              for (; nextEmitIndex < totalFrames; nextEmitIndex++) {
                if (!frame._rendering || renderFinished) return;
                const t = effectiveStart + nextEmitIndex / FPS;
                if (Math.abs(rv.currentTime - t) >= 0.001) {
                  await Promise.race([
                    new Promise(res => {
                      rv.addEventListener('seeked', res, { once: true });
                      rv.currentTime = t;
                    }),
                    new Promise(res => setTimeout(res, 1000)),
                  ]);
                  if (chatVid) chatVid.currentTime = t;
                }
                await emitFrameAt(nextEmitIndex);
              }
              if (!renderFinished) finalizeRender();
            } catch (e) { cleanup(); reject(e); }
          })();
        }

        console.log('Render: capture loop started — totalFrames:', totalFrames);
      }, { once: true });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEXT RENDERING
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

  function renderTitleAtY(ctx, lines, y, ts) {
    const font = `${ts.tFontWeight} ${ts.tFontSize}px ${ts.tFontFamily}`;
    ctx.font         = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    if (ts.tLetterSpacing) ctx.letterSpacing = `${ts.tLetterSpacing}px`;

    for (const line of lines) {
      const tw = ctx.measureText(line).width;
      const pw = tw + ts.tPillPadLeft + ts.tPillPadRight;
      const ph = ts.tLineHeight + ts.tPillPadTop + ts.tPillPadBottom;
      const px = (OUT_W - pw) / 2;
      drawPill(ctx, px, y, pw, ph, ts.tPillRadius, ts.tPillBg,
        ts.tPillBorderW, ts.tPillBorderC, ts.tPillShadow, ts.tPillOpacity);
      ctx.font      = font;
      ctx.textAlign = 'center';
      if (ts.tLetterSpacing) ctx.letterSpacing = `${ts.tLetterSpacing}px`;
      drawStyledText(ctx, line, OUT_W / 2, y + ph / 2,
        ts.tColor, ts.tTextShadow, ts.tStrokeWidth, ts.tStrokeColor);
      y += ph + ts.tPillMarginBot;
    }
    ctx.letterSpacing = '0px';
  }

  function renderSubWordAtY(ctx, text, y, ts) {
    const font = `${ts.sFontWeight} ${ts.sFontSize}px ${ts.sFontFamily}`;
    ctx.font         = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;

    const tw = ctx.measureText(text).width;
    const pw = tw + ts.sPillPadLeft + ts.sPillPadRight;
    const ph = ts.sLineHeight + ts.sPillPadTop + ts.sPillPadBottom;
    const px = (OUT_W - pw) / 2;
    drawPill(ctx, px, y, pw, ph, ts.sPillRadius, ts.sPillActiveBg,
      ts.sPillActiveBorderW, ts.sPillActiveBorderC,
      ts.sPillActiveShadow, ts.sPillActiveOpacity);
    ctx.font      = font;
    ctx.textAlign = 'center';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;
    drawStyledText(ctx, text, OUT_W / 2, y + ph / 2,
      ts.sActiveColor, ts.sActiveTextShadow,
      ts.sActiveStrokeWidth, ts.sActiveStrokeColor);
    ctx.letterSpacing = '0px';
  }

  function renderSubChunkAtY(ctx, chunk, activeIdx, y, ts) {
    const font = `${ts.sFontWeight} ${ts.sFontSize}px ${ts.sFontFamily}`;
    ctx.font         = font;
    ctx.textBaseline = 'middle';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;

    const wordGap = ts.sPillPadLeft;
    const ph      = ts.sLineHeight + ts.sPillPadTop + ts.sPillPadBottom;
    const metrics = chunk.map(w => ({ text: w.text, tw: ctx.measureText(w.text).width }));
    const totalW  = metrics.reduce((a, m) => a + m.tw + ts.sPillPadLeft + ts.sPillPadRight, 0)
                  + wordGap * Math.max(0, chunk.length - 1);
    let x = (OUT_W - totalW) / 2;

    for (let i = 0; i < metrics.length; i++) {
      const m        = metrics[i];
      const isActive = i === activeIdx;
      const pw       = m.tw + ts.sPillPadLeft + ts.sPillPadRight;
      drawPill(ctx, x, y, pw, ph, ts.sPillRadius,
        isActive ? ts.sPillActiveBg      : ts.sPillBg,
        isActive ? ts.sPillActiveBorderW : ts.sPillBorderW,
        isActive ? ts.sPillActiveBorderC : ts.sPillBorderC,
        isActive ? ts.sPillActiveShadow  : ts.sPillShadow,
        isActive ? ts.sPillActiveOpacity : ts.sPillOpacity);
      ctx.font      = font;
      ctx.textAlign = 'center';
      drawStyledText(ctx, m.text, x + pw / 2, y + ph / 2,
        isActive ? ts.sActiveColor       : ts.sColor,
        isActive ? ts.sActiveTextShadow  : ts.sTextShadow,
        isActive ? ts.sActiveStrokeWidth : ts.sStrokeWidth,
        isActive ? ts.sActiveStrokeColor : ts.sStrokeColor);
      x += pw + wordGap;
    }
    ctx.letterSpacing = '0px';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────────
  let _rendering     = false;
  let _progress      = 0;
  let _status        = 'idle';   // 'idle' | 'rendering' | 'done' | 'failed'
  let _lastBlob      = null;
  let _lastUrl       = null;
  let _lastThumbBlob = null;
  let _lastThumbUrl  = null;
  let _listUrls      = [];

  function _revokeListUrls() {
    _listUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    _listUrls = [];
  }

  window.renderAPI = {
    isRendering()    { return _rendering; },
    getProgress()    { return _progress; },
    getStatus()      { return _status; },
    getQuality()     { return _quality; },
    setQuality(q)    { if (QUALITY_PRESETS[q]) _quality = q; },
    getOutputBlob()  { return _lastBlob; },
    getOutputUrl()   { return _lastUrl; },
    getOutputType()  { return _lastBlob?.type || null; },
    getThumbBlob()   { return _lastThumbBlob; },
    getThumbUrl()    { return _lastThumbUrl; },

    download() {
      if (!_lastUrl || !_lastBlob) { console.warn('Render: nothing to download'); return; }
      const ext      = _lastBlob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
      const filename = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim() || 'render';
      try {
        const a    = document.createElement('a');
        a.href     = _lastUrl;
        a.download = `${filename}-render.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (_) { console.warn('Render: download blocked (iframe sandbox)'); }
    },

    async restoreLastRender() {
      let clipId = '';
      for (let i = 0; i < 40; i++) {
        clipId = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
        if (clipId) break;
        await new Promise(r => setTimeout(r, 250));
      }
      if (!clipId) { console.warn('Render: restore skipped — clip ID not found after 10 s'); return false; }
      const cached = await _loadCachedBlob(clipId);
      if (!cached) return false;
      if (_lastUrl)      URL.revokeObjectURL(_lastUrl);
      if (_lastThumbUrl) URL.revokeObjectURL(_lastThumbUrl);
      _lastBlob      = cached.blob;
      _lastUrl       = URL.createObjectURL(cached.blob);
      _lastThumbBlob = cached.thumbBlob?.size ? cached.thumbBlob : null;
      _lastThumbUrl  = _lastThumbBlob ? URL.createObjectURL(_lastThumbBlob) : null;
      _syncToWized({
        url: _lastUrl, type: cached.type, filename: cached.filename, ready: true,
        thumbUrl: _lastThumbUrl || '', thumbFilename: cached.thumbFilename || '',
        renderId: cached.renderId || '',
      });
      console.log('Render: restored from IndexedDB', clipId);
      return true;
    },

    async listCachedRenders() {
      _revokeListUrls();
      if (!_idbAvailable()) return [];
      try {
        const db    = await _openDB();
        const tx    = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const keys  = await new Promise((ok, err) => {
          const r = store.getAllKeys();
          r.onsuccess = () => ok(r.result);
          r.onerror   = err;
        });
        const entries = [];
        for (const key of keys) {
          const rec = await new Promise((ok, err) => {
            const r = store.get(key);
            r.onsuccess = () => ok(r.result);
            r.onerror   = err;
          });
          const hasThumb = !!(rec.thumbBlob?.size);
          let videoUrl = null;
          try {
            videoUrl = URL.createObjectURL(rec.blob);
            _listUrls.push(videoUrl);
          } catch (e) { console.warn('Render: could not create videoUrl for', key, e); }
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
            } catch (e) { console.warn('Render: could not create thumbUrl for', key, e); }
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
      if (_lastUrl)      URL.revokeObjectURL(_lastUrl);
      if (_lastThumbUrl) URL.revokeObjectURL(_lastThumbUrl);
      _lastBlob      = null;
      _lastUrl       = null;
      _lastThumbBlob = null;
      _lastThumbUrl  = null;
      _syncToWized(_WIZED_CLEAR);
      const clipId = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
      if (clipId) _clearCachedBlob(clipId);
    },
  };

  console.info('[canvas-render-done] loaded — build', _RENDER_SCRIPT_BUILD);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER ENTRY POINT
  // ─────────────────────────────────────────────────────────────────────────────
  window.renderClip = async function () {
    if (_rendering) { console.warn('Render: blocked — already rendering'); return; }

    _rendering = true;
    _progress  = 0;
    _status    = 'rendering';
    window.dispatchEvent(new CustomEvent('renderStateChange',
      { detail: { status: 'rendering', progress: 0 } }));

    try {
      const { video: blob, thumb: thumbBlob } = await renderComposition(progress => {
        _progress = Math.round(progress * 100);
        window.dispatchEvent(new CustomEvent('renderStateChange',
          { detail: { status: 'rendering', progress: _progress } }));
      });

      const title    = window.canvasAPI?.getState()?.title || '';
      const clipId   = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim() || 'clip';
      const renderId = _shortUUID();
      const safeName = (title || clipId)
        .replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_');
      const ext      = blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
      const filename = `${safeName || clipId}-render.${ext}`;
      const hasThumb      = !!(thumbBlob?.size);
      const thumbFilename = hasThumb ? `${safeName || clipId}-thumb.jpg` : '';

      if (_lastUrl)      URL.revokeObjectURL(_lastUrl);
      if (_lastThumbUrl) URL.revokeObjectURL(_lastThumbUrl);
      _lastBlob      = blob;
      _lastUrl       = URL.createObjectURL(blob);
      _lastThumbBlob = hasThumb ? thumbBlob : null;
      _lastThumbUrl  = hasThumb ? URL.createObjectURL(thumbBlob) : null;

      _cacheBlob(clipId, { blob, filename, renderId, thumbBlob: hasThumb ? thumbBlob : null, thumbFilename });
      _supabaseWriteRenderId(clipId, renderId);
      _syncToWized({
        url: _lastUrl, type: blob.type, filename, ready: true,
        thumbUrl: _lastThumbUrl || '', thumbFilename, renderId,
      });

      _status   = 'done';
      _progress = 100;
      window.dispatchEvent(new CustomEvent('renderStateChange',
        { detail: { status: 'done', progress: 100 } }));
      setTimeout(() => { _status = 'idle'; _progress = 0; }, 3000);

    } catch (err) {
      console.error('Render failed:', err);
      _status = 'failed';
      _syncToWized(_WIZED_CLEAR);
      window.dispatchEvent(new CustomEvent('renderStateChange',
        { detail: { status: 'failed', progress: _progress } }));
      setTimeout(() => { _status = 'idle'; _progress = 0; }, 3000);

    } finally {
      _rendering = false;
      const frame = document.querySelector('.clip_canvas');
      if (frame) frame._rendering = false;
      // Clean up any off-screen render elements left by a failed or aborted render.
      document.querySelectorAll('video[style*="-9999px"]').forEach(v => {
        try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (_) {}
      });
    }
  };

})();