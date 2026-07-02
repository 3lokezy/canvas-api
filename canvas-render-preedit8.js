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

  const _isSafariDesktop = !_isIOS &&
    /Safari/.test(navigator.userAgent) &&
    !/Chrome/.test(navigator.userAgent);

  const _isChromeIOS = _isIOS && /CriOS/.test(navigator.userAgent);

  /** Bump on deploy to surface cache/CDN issues in the console. */
  const _RENDER_SCRIPT_BUILD = 'pb-20260505v';

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
      const _table = /^\d+$/.test(String(clipId)) ? 'clips' : 'clips_live';
      await fetch(
        `${_SUPABASE_URL}/rest/v1/${_table}?id=eq.${encodeURIComponent(clipId)}`,
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
      console.log('Render: wrote render_id to', _table, renderId);
    } catch (e) {
      console.warn('Render: failed to write render_id to Supabase', e);
    }
  }

  (function _publishAudioCapabilityFlag() {
    const noAudio = _isIOS && typeof AudioEncoder === 'undefined';
    try {
      window.Wized = window.Wized || [];
      window.Wized.push((Wized) => {
        try { Wized.data.v.render_no_audio_browser = noAudio; } catch (_) {}
      });
    } catch (_) {}
  })();

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

  function loadVideo(src) {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.preload     = 'auto';
    v.playsInline = true;
    v.muted       = true;
    const isLargeSource = src.includes('vod.itclips.live');
v.src = isLargeSource ? src : src + (src.includes('?') ? '&' : '?') + '_r=' + Date.now();
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

  // Assemble OUTPUT-time clip audio for an NLE timeline: copy each clip's source PCM
  // into its output position (in output order), so cuts / reorders / deletes are
  // honoured and the audio lines up with the seek-based video frame-for-frame. Output
  // length = the playable timeline (sum of clips = getOutputDuration). The contiguous
  // trimAudioBuffer() path is only correct for a single uncut clip; this replaces it
  // whenever the timeline has clips.
  function buildNleClipAudio(audioCtx, sourceBuffer, clips, totalDuration) {
    const sr  = sourceBuffer.sampleRate;
    const ch  = sourceBuffer.numberOfChannels;
    const len = Math.max(1, Math.ceil(totalDuration * sr));
    const out = audioCtx.createBuffer(ch, len, sr);
    for (const c of clips) {
      const srcStart = Math.max(0, Math.floor(c.sourceStart * sr));
      const srcEnd   = Math.min(sourceBuffer.length, Math.ceil(c.sourceEnd * sr));
      const dstStart = Math.max(0, Math.floor(c.outputStart * sr));
      const n        = Math.min(srcEnd - srcStart, len - dstStart);
      if (n <= 0) continue;
      for (let k = 0; k < ch; k++) {
        out.copyToChannel(sourceBuffer.getChannelData(k).subarray(srcStart, srcStart + n), k, dstStart);
      }
    }
    return out;
  }

  function mixAudioBuffers(audioCtx, clipBuffer, clipVolume, musicBuffer, musicVolume, musicOffset, musicTrackStart, musicTrackEnd, effectiveStart) {
    const sr           = audioCtx.sampleRate;
    const outputLength = clipBuffer.length;
    const outputBuffer = audioCtx.createBuffer(2, outputLength, sr);
  
    for (let ch = 0; ch < 2; ch++) {
      const outData  = outputBuffer.getChannelData(ch);
  
      const clipCh   = Math.min(ch, clipBuffer.numberOfChannels - 1);
      const clipData = clipBuffer.getChannelData(clipCh);
      for (let i = 0; i < outputLength; i++) {
        outData[i] = clipData[i] * clipVolume;
      }
  
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

  function drawBackdropFrame(ctx, source, sourceW, sourceH, destW, destH, blurCanvas, blurCtx) {
    const scale = Math.max(destW / sourceW, destH / sourceH) * 1.2;   // overfill > blur → no dark edges (KEEP == canvas-webcodecs)
    const drawW = sourceW * scale, drawH = sourceH * scale;
    const drawX = (destW - drawW) / 2, drawY = (destH - drawH) / 2;

    if (_supportsCtxFilter) {
      ctx.save();
      ctx.filter = 'blur(40px)';   // KEEP == canvas-webcodecs BG_BLUR_REF (40/1080)
      ctx.drawImage(source, 0, 0, sourceW, sourceH, drawX, drawY, drawW, drawH);
      ctx.filter = 'none';
      ctx.restore();
      return;
    }

    if (!blurCanvas || !blurCtx) {
      ctx.drawImage(source, 0, 0, sourceW, sourceH, drawX, drawY, drawW, drawH);
      return;
    }

    const blurW = Math.max(1, Math.round(destW / 40));   // /40 ≈ blur(40px) for the no-ctx.filter fallback
    const blurH = Math.max(1, Math.round(destH / 40));
    if (blurCanvas.width !== blurW || blurCanvas.height !== blurH) {
      blurCanvas.width  = blurW;
      blurCanvas.height = blurH;
    }

    const bc  = Math.max(blurW / sourceW, blurH / sourceH) * 1.2;
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

  // Split a CSS shadow LIST ("c1 x y b, c2 x y b, …") on the top-level commas only — commas inside
  // rgba(…)/hsl(…) must NOT split. getComputedStyle normalises each shadow to "color offX offY [blur]"
  // (colour first), so the per-shadow regexes below match the computed form.
  function splitShadowList(raw) {
    if (!raw || raw === 'none') return [];
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of raw) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  // Returns an ARRAY of shadows (empty = none). CSS paints the FIRST-listed shadow on TOP; the draw
  // code iterates the array in reverse so the first ends up painted last (= on top). See drawPill/drawStyledText.
  function parseBoxShadows(raw, SF) {
    return splitShadowList(raw).map(one => {
      const m = one.match(/^(rgba?\([^)]+\)|hsla?\([^)]+\)|#\w+|\w+)\s+([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px(?:\s+([-\d.]+)px)?/);
      if (!m) return null;
      return { color: m[1], offsetX: parseFloat(m[2]) * SF, offsetY: parseFloat(m[3]) * SF, blur: parseFloat(m[4]) * SF, spread: parseFloat(m[5] || 0) * SF };
    }).filter(Boolean);
  }

  function parseTextShadows(raw, SF) {
    return splitShadowList(raw).map(one => {
      const m = one.match(/^(rgba?\([^)]+\)|hsla?\([^)]+\)|#\w+|\w+)\s+([-\d.]+)px\s+([-\d.]+)px(?:\s+([-\d.]+)px)?/);
      if (!m) return null;
      return { color: m[1], offsetX: parseFloat(m[2]) * SF, offsetY: parseFloat(m[3]) * SF, blur: parseFloat(m[4] || 0) * SF };
    }).filter(Boolean);
  }

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
      s.tPillShadow    = parseBoxShadows(cs.boxShadow, SF);
      s.tPillOpacity   = parseFloat(cs.opacity) ?? 1;
    } else {
      s.tPillPadTop = s.tPillPadBottom = 0.008 * OUT_W;
      s.tPillPadLeft = s.tPillPadRight = 0.018 * OUT_W;
      s.tPillRadius    = 0.0245 * OUT_W;
      s.tPillMarginBot = -0.01 * OUT_W;
      s.tPillBg        = 'rgba(0,0,0,0.7)';
      s.tPillBorderW   = 0;
      s.tPillBorderC   = 'transparent';
      s.tPillShadow    = [];
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
      s.tTextShadow    = parseTextShadows(cs.textShadow, SF);
      s.tStrokeWidth   = readPx(cs, 'webkitTextStrokeWidth') * SF;
      s.tStrokeColor   = cs.webkitTextStrokeColor || 'transparent';
    } else {
      s.tFontSize      = 0.06 * OUT_W;
      s.tFontWeight    = '700';
      s.tFontFamily    = 'sans-serif';
      s.tColor         = '#fff';
      s.tLineHeight    = s.tFontSize * 1.2;
      s.tLetterSpacing = 0;
      s.tTextShadow    = [];
      s.tStrokeWidth   = 0;
      s.tStrokeColor   = 'transparent';
    }

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
      s.sPillShadow    = parseBoxShadows(cs.boxShadow, SF);
      s.sPillOpacity   = parseFloat(cs.opacity) ?? 1;

      const wasActive = subPill.classList.contains('is-active');
      if (!wasActive) subPill.classList.add('is-active');
      const acs            = getComputedStyle(subPill);
      s.sPillActiveBg      = acs.backgroundColor;
      s.sPillActiveBorderW = readPx(acs, 'borderTopWidth') * SF;
      s.sPillActiveBorderC = acs.borderTopColor;
      s.sPillActiveShadow  = parseBoxShadows(acs.boxShadow, SF);
      s.sPillActiveOpacity = parseFloat(acs.opacity) ?? 1;
      if (!wasActive) subPill.classList.remove('is-active');
    } else {
      s.sPillPadTop = s.sPillPadBottom = 0.006 * OUT_W;
      s.sPillPadLeft = s.sPillPadRight = 0.012 * OUT_W;
      s.sPillRadius        = 0.015 * OUT_W;
      s.sPillBg            = 'rgba(0,0,0,0.5)';
      s.sPillBorderW       = 0;
      s.sPillBorderC       = 'transparent';
      s.sPillShadow        = [];
      s.sPillOpacity       = 1;
      s.sPillActiveBg      = s.sPillBg;
      s.sPillActiveBorderW = 0;
      s.sPillActiveBorderC = 'transparent';
      s.sPillActiveShadow  = [];
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
      s.sTextShadow    = parseTextShadows(cs.textShadow, SF);
      s.sStrokeWidth   = readPx(cs, 'webkitTextStrokeWidth') * SF;
      s.sStrokeColor   = cs.webkitTextStrokeColor || 'transparent';

      const pill      = subText.closest('.subtitle_pill');
      const wasActive = pill?.classList.contains('is-active');
      if (pill && !wasActive) pill.classList.add('is-active');
      const acs            = getComputedStyle(subText);
      s.sActiveColor       = acs.color;
      s.sActiveStrokeWidth = readPx(acs, 'webkitTextStrokeWidth') * SF;
      s.sActiveStrokeColor = acs.webkitTextStrokeColor || 'transparent';
      s.sActiveTextShadow  = parseTextShadows(acs.textShadow, SF);
      if (pill && !wasActive) pill.classList.remove('is-active');
    } else {
      s.sFontSize          = 0.055 * OUT_W;
      s.sFontWeight        = '700';
      s.sFontFamily        = 'sans-serif';
      s.sColor             = '#fff';
      s.sLineHeight        = s.sFontSize * 1.2;
      s.sLetterSpacing     = 0;
      s.sTextShadow        = [];
      s.sStrokeWidth       = 0;
      s.sStrokeColor       = 'transparent';
      s.sActiveColor       = '#fff';
      s.sActiveStrokeWidth = 0;
      s.sActiveStrokeColor = 'transparent';
      s.sActiveTextShadow  = [];
    }

    return s;
  }

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

    const _nleClips  = api.getOutputClips?.() ?? [];
    const isNLE      = _nleClips.length > 0;
    // Raw clips carry per-clip `override.facecam` — the split bottom crop for THIS clip (which region/who).
    const _rawClips  = api.getClips?.() ?? [];
    const _clipById  = new Map(_rawClips.map(c => [c.id, c]));
    const totalDuration = isNLE
      ? (api.getOutputDuration?.() ?? 0)
      : (effectiveEnd - effectiveStart);
    if (totalDuration <= 0) throw new Error('No playback range');
    const isInSource = isNLE ? false : (effectiveStart > 0);

    // ── Engine-capture render ──────────────────────────────────────────────────
    // When the WebCodecs engine owns this NLE timeline, render by recording a
    // REALTIME playthrough of it: the engine already does gapless cuts/reorders +
    // gapless audio on one AudioContext clock, so we just composite its canvas +
    // overlays and capture via MediaRecorder. This avoids the seek-per-frame loop
    // that MediaRecorder stretched into slow-motion, and skips loading a second
    // `rv` video that competed with the engine for decode bandwidth.
    const _eng = (isNLE
      && window.wcEngine?.isActive?.()
      && typeof window.wcEngine.currentFrameCanvas === 'function'
      && typeof window.wcEngine.audioContext === 'function')
      ? window.wcEngine : null;
    const _useEngine = !!_eng;

    frame._rendering  = true;
    const _gpWasMuted = gpVideo.muted;
    gpVideo.pause();
    gpVideo.muted = true;
    onProgress?.(0);

    let rv = null;
    if (!_useEngine) {
      console.log('Render: [1] loading video…');
      rv = await loadVideo(gpVideo.currentSrc || gpVideo.src);
      rv.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-9999;';
      document.body.appendChild(rv);
    } else {
      console.log('Render: [1] engine-capture mode — gameplay from WebCodecs engine canvas (no rv load)');
    }

    const chatUrl = document.querySelector('[wized="stream_clip_chat"]')?.textContent.trim();
    const chatVid = (chatUrl && state.chatVisible)
      ? await loadVideo(chatUrl).catch(() => null)
      : null;

    const imgSrc = state.imgSrc;
    const imgObj = (imgSrc && state.imageVisible)
      ? await loadImage(imgSrc).catch(() => null)
      : null;

    // Multi-image track: preload each cue's image once (crossOrigin so the draw doesn't taint the export —
    // requires the host to send CORS, e.g. Tenor/R2). url→Image map; failed loads drop out (never a broken draw).
    // For animated GIF/WebP cues ALSO decode frames via wcGif (ImageDecoder) so the export animates; the static
    // Image stays as a frame-0 fallback (Firefox / unsupported). Both are per-SOURCE, awaited before capture.
    const _imageCues = api.getImageCues?.() || [];
    const _imgCache  = new Map();
    await Promise.all([...new Set(_imageCues.map(c => c.url))].map(u => {
      const jobs = [loadImage(u).then(img => { if (img) _imgCache.set(u, img); }).catch(() => {})];
      if (window.wcGif?.supported && window.wcGif.isGifUrl(u)) jobs.push(window.wcGif.ensure(u).catch(() => {}));
      return Promise.all(jobs);
    }));

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
        v.src        = wmSrc;
        const done = () => res(v);
        const fail = () => res(null);
        const t    = setTimeout(fail, 8000);
        v.addEventListener('canplay', () => { clearTimeout(t); done(); }, { once: true });
        v.addEventListener('error',   () => { clearTimeout(t); fail(); }, { once: true });
        v.load();
      }).catch(() => null)
    : null;
  if (wmVid) wmVid.loop = true;

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


    const editorW = frame.clientWidth || 1;
    const SF      = OUT_W / editorW;
    const ts      = snapshotTextLayout(SF);

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

    console.log('Render: [2] checking MP4 support…');
    const webCodecsMp4Ok = await ensureMp4Support();

    // Mediabunny deliberately disabled (slower + problematic on some browsers/devices).
    // MediaRecorder is the chosen encoder. NOTE: MediaRecorder records WALL-CLOCK
    // realtime, so the render must feed the canvas at realtime pace — a seek-per-frame
    // NLE loop produces slow-motion. See the NLE render plan.
    const useMp4 = false;
    const _noAudioIOS = _isIOS && typeof AudioEncoder === 'undefined';

    console.log('Render: [3] encoding —',
      'useMp4:', useMp4,
      _isIOS       ? '(iOS)'                                            : '',
      _isChromeIOS ? '(Chrome iOS, raw-AAC remux)'
                   : _noAudioIOS ? '(Safari iOS no AudioEncoder, raw-AAC remux)' : '',
      typeof AudioEncoder !== 'undefined'                     ? 'AudioEncoder:yes' : 'AudioEncoder:no',
      _useEngine ? 'engine-capture' : (rv && typeof rv.requestVideoFrameCallback === 'function') ? 'rVFC:yes' : 'rVFC:no');

    // Engine-capture audio (built on the engine's own AudioContext → one clock, no drift).
    let _engCapDest   = null;   // MediaStreamDestination fed by engine clip audio + music
    let _engMusicBuffer = null; // decoded music, started in sync with the engine playthrough
    let _engMusicSrc  = null;
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
    let mp4AudioAddPromise = null;
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

      setupMp4AudioSource = async () => {
        if (!audioCtx || audioSource) return;
    

        if (typeof AudioEncoder === 'undefined') {
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
          // NLE timelines: build cut/reorder-aware output audio from the clips.
          // Single-clip / legacy: contiguous trim. Both yield an output-time buffer
          // (length = totalDuration) that mixAudioBuffers then lays music over.
          const clipBuffer = isNLE
            ? buildNleClipAudio(audioCtx, fullPcm, api.getOutputClips?.() ?? [], totalDuration)
            : trimAudioBuffer(audioCtx, fullPcm, effectiveStart, effectiveEnd);
          fullPcm          = null;
        
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
            state.musicMuted ? null : musicBuffer,
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

      if (typeof AudioEncoder !== 'undefined') {
        await setupMp4AudioSource();
      }

      startMp4Output = async () => {
        if (outputStarted) return;
        console.log('Render: [4] creating Mediabunny output…');
        videoSource = createVideoSource();
        output = new Output({
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
        if (audioSource && mp4AudioBuffer) {
          mp4AudioAddPromise = audioSource.add(mp4AudioBuffer);
        }
        console.log('Render: [5] output started');
      };

    } else {
      if (typeof rc.captureStream !== 'function') {
        throw new Error('captureStream not supported — cannot record on this browser');
      }
      const stream = rc.captureStream(FPS);
      try {
        if (_useEngine) {
          // Capture the engine's gapless clip audio on its OWN AudioContext (one clock
          // with the video), plus a music BufferSource started in sync in the loop.
          const eactx = _eng.audioContext();
          if (eactx.state === 'suspended') { try { await eactx.resume(); } catch (_) {} }
          _engCapDest = eactx.createMediaStreamDestination();
          try { _eng.setVolume(state.clipVolume ?? 1.0); } catch (_) {}
          _eng.tapAudio(_engCapDest);
          if (state.musicUrl && !state.musicMuted) {
            try {
              const _mRes = await fetch(state.musicSrc || state.musicUrl, { cache: 'no-store' });
              _engMusicBuffer = await eactx.decodeAudioData(await _mRes.arrayBuffer());
              console.log('Render: engine music decoded —', _engMusicBuffer.duration.toFixed(2), 's');
            } catch (e) {
              console.warn('Render: engine music decode failed — clip audio only:', e.message);
            }
          }
          _engCapDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        } else {
        audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') {
          await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]);
        }
        if (isInSource) {
          const _gpCapture = typeof gpVideo.captureStream === 'function'
            ? gpVideo.captureStream() : null;
          const _mixDest = audioCtx.createMediaStreamDestination();

          if (_gpCapture?.getAudioTracks().length) {
            const _gpStreamSrc = audioCtx.createMediaStreamSource(_gpCapture);
            const _gpGain      = audioCtx.createGain();
            _gpGain.gain.value = state.clipVolume ?? 1.0;
            _gpStreamSrc.connect(_gpGain);
            _gpGain.connect(_mixDest);
          }

          console.log('Render: music state —', state.musicUrl, '| muted:', state.musicMuted, '| src:', state.musicSrc);
          if (state.musicUrl && !state.musicMuted) {
            try {
              const _mRes  = await fetch(state.musicSrc || state.musicUrl);
              const _mBuf  = await audioCtx.decodeAudioData(await _mRes.arrayBuffer());
              const _mGain = audioCtx.createGain();
              _mGain.gain.value = state.musicVolume ?? 0.8;
              _mGain.connect(_mixDest);
              frame._pendingMusicNode = { buffer: _mBuf, gainNode: _mGain };
              console.log('Render: music decoded —', _mBuf.duration.toFixed(2), 's, pendingNode set');
            } catch (e) {
              console.warn('Render: music decode failed —', e.message);
            }
          }

          _mixDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        } else {
          const src  = audioCtx.createMediaElementSource(rv);
          const dest = audioCtx.createMediaStreamDestination();
          src.connect(dest);
          dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        }
        }
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

    // Base mode = fallback only. The EFFECTIVE mode is resolved PER FRAME in drawCanvasFrame via
    // _modeCtx() (B3): during the engine-capture playthrough the reframe sampler applies each
    // clip's cascaded mode to the live DOM, so split/overlay/full + the gameplay/facecam vertical
    // split now export per clip instead of being locked to whatever mode the preview started in.
    const mode = state.mode;

    const _gpSrcEl = _useEngine ? _eng.currentFrameCanvas() : (isInSource ? gpVideo : rv);
    const vw = _gpSrcEl.videoWidth  || _gpSrcEl.width;
    const vh = _gpSrcEl.videoHeight || _gpSrcEl.height;

    const editorHW = gpHold.clientWidth  || 1;
    const editorHH = gpHold.clientHeight || 1;

    // Gameplay crop derived PER FRAME from gpVideo's LIVE geometry. The reframe sampler sets
    // per-clip zoom + pan + tracking on gpVideo during the engine-capture playthrough, and the
    // visible source fraction matches preview (dw/OUT_W == gpVideo.offsetWidth/holdWidth) — so
    // reading it each frame keeps the export in lockstep, including per-clip punch-ins. When
    // nothing overrides, this equals the old static vw*coverScale*zoom (same aspect holds).
    function _gpRect(gpHoldH) {
      const eL  = parseFloat(gpVideo.style.left) || 0, eT = parseFloat(gpVideo.style.top) || 0;
      const eDW = gpVideo.offsetWidth || 1,            eDH = gpVideo.offsetHeight || 1;
      const holdW = gpHold.clientWidth  || editorHW || 1;   // LIVE: split mode resizes the hold per clip
      const holdH = gpHold.clientHeight || editorHH || 1;
      const dw  = OUT_W   * (eDW / holdW);
      const dh  = gpHoldH * (eDH / holdH);
      const panCX = (eL + eDW / 2) / holdW, panCY = (eT + eDH / 2) / holdH;
      const gpL = dw > OUT_W   ? Math.max(OUT_W - dw,   Math.min(0, panCX * OUT_W   - dw / 2)) : (OUT_W - dw) / 2;
      const gpT = dh > gpHoldH ? Math.max(gpHoldH - dh, Math.min(0, panCY * gpHoldH - dh / 2)) : (gpHoldH - dh) / 2;
      return { gpL, gpT, dw, dh };
    }

    // Per-frame effective MODE + region heights, read from the LIVE preview DOM (B3 render parity).
    // The engine applies each clip's cascaded mode during the capture playthrough (frame._currentMode
    // + gpHold resize), so reading it here keeps export in lockstep with the per-clip mode — same
    // philosophy as _gpRect reading gpVideo's live geometry. hasFacecam / fcCrop are per-SOURCE
    // (constant across clips); only the PRESENTATION (split/overlay/none + vertical split) varies.
    function _modeCtx() {
      const cm = frame._currentMode || mode || 'is-full';
      const fH = frame.clientHeight || 1;
      const gpHoldH = cm === 'is-split'
        ? Math.round(OUT_H * ((gpHold.clientHeight || fH) / fH))
        : OUT_H;
      return { mode: cm, gpHoldH, fcHoldH: cm === 'is-split' ? OUT_H - gpHoldH : 0 };
    }

    // Source-badge bar geometry, recomputed LIVE per frame. The .kt_overlay_placement_bar is
    // repositioned by applyMode per clip (sits at the split SEAM in split mode, released to its
    // Webflow default otherwise). Reading its live rect each frame makes the export follow the
    // per-clip seam instead of freezing at whatever mode the render started in. Styles
    // (fonts/colours/logo/text) stay in the once-captured badgeLayout. Returns null → use static.
    function _badgeGeom() {
      if (!barEl) return null;
      const cW = frame.clientWidth || 1, cH = frame.clientHeight || 1;
      const SF_W = OUT_W / cW, SF_H = OUT_H / cH;
      const cRect = frame.getBoundingClientRect();
      const bR = barEl.getBoundingClientRect();
      if (!bR.height) return null;
      const lR = imgEl?.getBoundingClientRect();
      const tR = txtEl?.getBoundingClientRect();
      return {
        barY:  (bR.top - cRect.top) * SF_H,
        barH:  bR.height * SF_H,
        logoX: lR ? (lR.left - cRect.left) * SF_W : 0,
        logoY: lR ? (lR.top  - cRect.top)  * SF_H : 0,
        logoW: lR ? lR.width  * SF_W : 0,
        logoH: lR ? lR.height * SF_H : 0,
        textX: tR ? (tR.right - cRect.left) * SF_W : OUT_W,
        textY: tR ? (tR.top - cRect.top + tR.height / 2) * SF_H : 0,
      };
    }

    // Facecam crop: Supabase attrs WIN; else fall back to the INJECTED crop (setFacecamCrop → state.facecamCrop —
    // auto-layout's scan cam / AI facecam, set when Supabase has none). The PREVIEW (reapplyCrop) already does this
    // fallback; the render used to read Supabase attrs ONLY, so a split clip with an INJECTED cam rendered a BLACK
    // bottom half (no facecam branch, and _chatInSplit needs !hasFacecam+a chat). Keying hasFacecam off a VALID
    // crop (not just the boolean attr) also means a cam-claimed-but-cropless clip falls through to chat-fill, never
    // black. fcCrop is per-SOURCE (the cam box is constant across the source's clips), same as the attrs it replaces.
    const _sbSaysCam = document.querySelector(
      '[wized="stream_clip_contains_facecam"]'
    )?.textContent.trim().toLowerCase() === 'true';

    let fcCrop = null;
    if (_sbSaysCam) {
      const x1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x1"]')?.textContent);
      const y1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y1"]')?.textContent);
      const x2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x2"]')?.textContent);
      const y2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y2"]')?.textContent);
      if ([x1, y1, x2, y2].every(isFinite) && x2 > x1 && y2 > y1) fcCrop = { x1, y1, x2, y2 };
    }
    if (!fcCrop && state.facecamCrop) {                       // injected cam (Supabase had none) — match the preview
      const b = state.facecamCrop;
      if ([b.x1, b.y1, b.x2, b.y2].every(isFinite) && b.x2 > b.x1 && b.y2 > b.y1) fcCrop = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
    }
    // A facecam is available if the source has a base crop OR any clip carries a per-clip override.facecam
    // (duo split / dynamic cam). Broadened so split renders + the chat-fill fallback stays correct.
    const hasFacecam = state.facecamVisible && (!!fcCrop || _rawClips.some(c => c.override && c.override.facecam));
    // Effective crop for the CURRENT clip: its override.facecam else the base fcCrop. Read per frame so the
    // bottom panel swaps per clip (mirrors the preview's _applyReframe→item._crop).
    function _effCrop() {
      const cid = _useEngine ? _eng.currentClipId?.() : null;
      const ov = cid && _clipById.get(cid)?.override?.facecam;
      if (ov && isFinite(ov.x1) && isFinite(ov.x2) && ov.x2 > ov.x1 && ov.y2 > ov.y1) return ov;
      return fcCrop;
    }

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

    let chatLayout = null;
    if (chatVid && state.chatVisible) {
      chatLayout = {
        x: state.chatX * OUT_W - (state.chatW * OUT_W) / 2,
        y: state.chatY * OUT_H - (state.chatH * OUT_H) / 2,
        w: state.chatW * OUT_W,
        h: state.chatH * OUT_H,
      };
    }

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
          // Segment clips are 0-based but the transcript is VOD-absolute — rebase by source_start
          // (mirrors canvas-api _rebaseTranscriptForSegment). Idempotent: skips already-0-based data.
          if (/\/clips\//i.test(gpVideo?.currentSrc || gpVideo?.src || '')) {
            const _off = parseFloat(document.querySelector('[wized="stream_clip_source_start"]')?.textContent.trim() || '0') * 1000;
            if (_off > 0 && transcript[0].start >= _off) {
              transcript = transcript.map(w => ({ ...w, start: Math.max(0, w.start - _off), end: Math.max(0, w.end - _off) }));
            }
          }
          if (subMode === 'chunk') {
            subChunks = [];
            for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
              subChunks.push(transcript.slice(i, i + CHUNK_SIZE));
            }
          }
        }
      }
    } catch (_) {}

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

    return new Promise((resolve, reject) => {

      function cleanup() {
        frame._rendering = false;
        if (rv && _rvfcHandle != null && typeof rv.cancelVideoFrameCallback === 'function') {
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
        // Restore the engine to its pre-render state (it keeps driving the preview).
        if (_useEngine) {
          try { _engMusicSrc?.stop(); } catch (_) {}
          try { _eng.untapAudio(_engCapDest); } catch (_) {}
          try { _eng.setVolume(1); } catch (_) {}
        }
        if (rv && !isInSource) rv.pause();
        gpVideo.pause();
        gpVideo.muted = _gpWasMuted;
        if (chatVid) chatVid.pause();
        if (rv && !isInSource) {
          rv.removeAttribute('src'); rv.load();
          try { rv.parentNode?.removeChild(rv); } catch (_) {}
        }
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

          console.log('Render: closing videoSource…');
          try { videoSource.close(); }
          catch (e) { console.error('Render: videoSource.close() threw:', e); throw e; }

          if (mp4AudioAddPromise) {
            console.log('Render: awaiting audio encode completion…');
            try { await mp4AudioAddPromise; }
            catch (e) { console.warn('Render: audio encode promise rejected:', e); }
          }

          console.log('Render: closing audioSource…');
          try { if (audioSource) audioSource.close(); }
          catch (e) { console.error('Render: audioSource.close() threw:', e); throw e; }

          mp4AudioBuffer = null;

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

      const _renderBase     = isNLE ? (_nleClips[0]?.sourceStart ?? 0) : effectiveStart;
      const prerollDuration = 2 / FPS;
      const prerollStart    = Math.max(0, _renderBase - prerollDuration);
      let primedExactStart  = Math.abs(prerollStart - _renderBase) < 0.0001;

      const _onSeeked = async function onSeeked() {
        if (rv) rv.removeEventListener('seeked', onSeeked);

        if (rv && !primedExactStart) {
          primedExactStart    = true;
          rv.currentTime      = _renderBase;
          gpVideo.currentTime = _renderBase;
          if (chatVid) chatVid.currentTime = _renderBase;
          console.log('Render: decoder primed, seeking to', _renderBase.toFixed(3));
          rv.addEventListener('seeked', onSeeked, { once: true });
          return;
        }

        console.log('Render: seeked — starting playback…');
        try {
          if (rv) {
            await rv.play();
            console.log('Render: play resolved — time:', rv.currentTime.toFixed(3));
            if (!(useMp4 && mp4AudioBuffer)) {
              rv.muted  = false;
              rv.volume = 0;
            }
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

        if (_useEngine) {
          // Realtime engine playthrough. Start the recorder, reset + play the engine
          // (its AudioContext clock drives both its audio and video frames), and start
          // music in sync on that same context. The rAF loop below composites the
          // engine canvas + overlays onto rc, which the recorder captures in realtime.
          recorder.start(100);
          const eactx = _eng.audioContext();
          _eng.seekOutput(0);
          const _t0 = eactx.currentTime;
          if (_engMusicBuffer) {
            const trackStart = Math.max(0, (tracks.music?.start ?? effectiveStart) - effectiveStart);
            const trackEnd   = Math.max(0, (tracks.music?.end   ?? (effectiveStart + totalDuration)) - effectiveStart);
            const mgain = eactx.createGain();
            mgain.gain.value = state.musicVolume ?? 0.8;
            mgain.connect(_engCapDest); mgain.connect(eactx.destination);
            _engMusicSrc = eactx.createBufferSource();
            _engMusicSrc.buffer = _engMusicBuffer;
            _engMusicSrc.connect(mgain);
            try { _engMusicSrc.start(_t0 + trackStart, state.musicOffset ?? 0, Math.max(0, trackEnd - trackStart)); } catch (_) {}
          }
          if (chatVid) { try { chatVid.currentTime = _renderBase; chatVid.muted = true; chatVid.play().catch(() => {}); } catch (_) {} }
          _eng.play();
        } else if (!useMp4) {
          gpVideo.play().catch(() => {});
          if (chatVid) { chatVid.muted = true; chatVid.play().catch(() => {}); }
          if (frame._pendingMusicNode && audioCtx) {
            const { buffer, gainNode } = frame._pendingMusicNode;
            frame._pendingMusicNode = null;
            console.log('Render: starting music — trackStart:', tracks.music?.start, 'offset:', state.musicOffset, 'ctx time:', audioCtx.currentTime);
            const trackStart = Math.max(0, (tracks.music?.start ?? effectiveStart) - effectiveStart);
            const trackEnd   = Math.max(0, (tracks.music?.end   ?? (effectiveStart + totalDuration)) - effectiveStart);
            const src = audioCtx.createBufferSource();
            src.buffer = buffer;
            src.connect(gainNode);
            src.start(
              audioCtx.currentTime + trackStart,
              state.musicOffset ?? 0,
              Math.max(0, trackEnd - trackStart)
            );
          }
          recorder.start(100);
        } else {
          if (chatVid) chatVid.pause();
        }

        // t = SOURCE time. Title/image/subtitle visibility windows are stored in SOURCE time (the
        // default window is the source window), so they gate on t too.
        function drawCanvasFrame(t) {
          const _ds = _useEngine ? _eng.currentFrameCanvas() : (isInSource ? gpVideo : rv);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, OUT_W, OUT_H);

          // Effective mode for THIS frame (per-clip / cascaded) — read live; see _modeCtx.
          const { mode: cm, gpHoldH: gpH, fcHoldH: fcH } = _modeCtx();

          if (cm !== 'is-split') {
            drawBackdropFrame(ctx, _ds, vw, vh, OUT_W, OUT_H, blurCanvas, blurCtx);
          }

          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, OUT_W, gpH);
          ctx.clip();
          const { gpL, gpT, dw, dh } = _gpRect(gpH);
          ctx.drawImage(_ds, 0, 0, vw, vh, gpL, gpT, dw, dh);
          ctx.restore();

          const _fc = _effCrop();                                    // per-clip override.facecam ELSE base
          if (_fc && hasFacecam) {
            const srcX = _fc.x1 * vw, srcY = _fc.y1 * vh;
            const srcW = (_fc.x2 - _fc.x1) * vw;
            const srcH = (_fc.y2 - _fc.y1) * vh;

            if (cm === 'is-split') {
              const fcScale = Math.max(OUT_W / srcW, fcH / srcH);
              const fcDW    = srcW * fcScale, fcDH = srcH * fcScale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(0, gpH, OUT_W, fcH);
              ctx.clip();
              ctx.drawImage(_ds, srcX, srcY, srcW, srcH,
                (OUT_W - fcDW) / 2, gpH + (fcH - fcDH) / 2, fcDW, fcDH);
              ctx.restore();
            } else if (cm === 'is-overlay') {
              const olW = state.facecamW * OUT_W, olH = state.facecamH * OUT_H;
              const olX = state.facecamX * OUT_W - olW / 2;
              const olY = state.facecamY * OUT_H - olH / 2;
              const fcScale = Math.max(olW / srcW, olH / srcH);
              const fcDW    = srcW * fcScale, fcDH = srcH * fcScale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(olX, olY, olW, olH);
              ctx.clip();
              ctx.drawImage(_ds, srcX, srcY, srcW, srcH,
                olX + (olW - fcDW) / 2, olY + (olH - fcDH) / 2, fcDW, fcDH);
              ctx.restore();
            }
          }

          // Split mode with NO facecam → chat FILLS the bottom region (mirrors the preview's
          // .chat_split_video objectFit:cover that replaces the facecam). Opaque, no blend.
          const _chatInSplit = cm === 'is-split' && !hasFacecam;
          if (_chatInSplit && chatVid && state.chatVisible) {
            const bw = OUT_W, bh = fcH, by = gpH;
            const cvw = chatVid.videoWidth || bw, cvh = chatVid.videoHeight || bh;
            const scale = Math.max(bw / cvw, bh / cvh);   // cover
            const dW = cvw * scale, dH = cvh * scale;
            ctx.save();
            ctx.beginPath(); ctx.rect(0, by, bw, bh); ctx.clip();
            ctx.drawImage(chatVid, (bw - dW) / 2, by + (bh - dH) / 2, dW, dH);
            ctx.restore();
          }

          // Legacy single-image (manual upload) — SUPPRESSED when multi-image cues exist (the cue system is
          // authoritative then, matching the preview) so they never double-draw or diverge.
          if (imgLayout && state.imageVisible && !_imageCues.length) {
            const imgStart = tracks.image?.start ?? 0;
            const imgEnd   = tracks.image?.end   ?? duration;
            if (t >= imgStart && t <= imgEnd) {   // source-time window
              ctx.drawImage(imgObj, imgLayout.x, imgLayout.y, imgLayout.w, imgLayout.h);
            }
          }

          // Multi-image track cues — OUTPUT-time anchored (like the soundboard/FX). Draw every cue whose
          // window contains the current output moment, sorted so later cues stack on top. Scale is a fraction
          // of OUT_W; x/y are the normalized CENTRE. Mirrors the preview's per-cue overlay placement.
          if (_imageCues.length) {
            const _ot = _useEngine ? _eng.currentOutputTime() : t;   // output time under the engine (prod); source≈output on the legacy path (mirrors FX)
            for (const c of _imageCues) {
              if (_ot < c.outputStart || _ot >= c.outputEnd) continue;
              // Animated GIF/WebP → the frame sampled at this output moment (loops); else the static image.
              let src = null, sw = 0, sh = 0;
              const gif = (window.wcGif?.supported && window.wcGif.isGifUrl(c.url))
                ? window.wcGif.frameAt(c.url, _ot - c.outputStart) : null;
              if (gif) { src = gif; sw = gif.width; sh = gif.height; }
              else { const im = _imgCache.get(c.url); if (im && im.naturalWidth) { src = im; sw = im.naturalWidth; sh = im.naturalHeight; } }
              if (!src || !sw) continue;
              const w = c.scale * OUT_W;
              const h = w * (sh / sw);
              ctx.drawImage(src, c.x * OUT_W - w / 2, c.y * OUT_H - h / 2, w, h);
            }
          }

          // Floating chat overlay — full/overlay mode, or split WITH a facecam (where chat stays a
          // floating overlay). Skipped when chat is filling the split bottom region (handled above).
          if (!_chatInSplit && chatVid && chatLayout && state.chatVisible) {
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

          {
            const tl     = api.getTextLayout();
            const titleY = (tl.titleY ?? 0) * OUT_H;
            const subY   = (tl.subY   ?? 0) * OUT_H;

            if (titleLines.length && state.titleVisible) {
              const titleStart = tracks.title?.start ?? 0;
              const titleEnd   = tracks.title?.end   ?? duration;
              if (t >= titleStart && t <= titleEnd) renderTitleAtY(ctx, titleLines, titleY, ts);   // source-time window
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
                if (foundChunk !== -1) {
                  const aw = subChunks[foundChunk][foundWord];
                  renderSubChunkAtY(ctx, subChunks[foundChunk], foundWord, subY, ts, _subAnim(state.subtitleStyle, ms - aw.start));
                }
              } else {
                const word = transcript.find(w => ms >= w.start && ms < w.end);
                if (word) renderSubWordAtY(ctx, word.text, subY, ts, _subAnim(state.subtitleStyle, ms - word.start));
              }
            }
          }

           if (wmVid) {
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            if (wmOpacity < 1) ctx.globalAlpha = wmOpacity;
            ctx.drawImage(wmVid, 0, 0, OUT_W, OUT_H);
            ctx.restore();
           }

          if (kickLogo && badgeLayout) {
            const g = _badgeGeom() || badgeLayout;   // LIVE position (follows the per-clip split seam); falls back to static
            ctx.save();
            ctx.fillStyle = badgeLayout.barBg;
            ctx.fillRect(0, g.barY, OUT_W, g.barH);
            ctx.drawImage(kickLogo, g.logoX, g.logoY, g.logoW, g.logoH);
            ctx.font = `${badgeLayout.textWeight} ${badgeLayout.textSize}px ${badgeLayout.textFamily}`;
            ctx.letterSpacing = badgeLayout.letterSpacing;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'right';
            ctx.lineJoin = 'round';
            if (badgeLayout.behindStrokeW > 0) {
              ctx.lineWidth   = badgeLayout.behindStrokeW;
              ctx.strokeStyle = badgeLayout.behindStrokeColor;
              ctx.strokeText(badgeText, g.textX, g.textY);
            }
            if (badgeLayout.textStrokeW > 0) {
              ctx.lineWidth   = badgeLayout.textStrokeW;
              ctx.strokeStyle = badgeLayout.textStrokeColor;
              ctx.strokeText(badgeText, g.textX, g.textY);
            }
            ctx.fillStyle = badgeLayout.textColor;
            ctx.fillText(badgeText, g.textX, g.textY);
            ctx.restore();
          }

          // Overlay FX (colour flash / desaturate) — output-anchored, so read the engine's
          // output time. Same fxIntensityAt() the live preview uses → export matches preview.
          // Desaturate = a grayscale copy of the whole frame composited over itself at the cue's
          // intensity (needs ctx.filter; skipped if unsupported). Flash = a translucent fill on top.
          const fx = api.fxIntensityAt?.(_useEngine ? _eng.currentOutputTime() : t);
          if (fx) {
            if (fx.desat > 0 && _supportsCtxFilter) {
              ctx.save();
              ctx.globalAlpha = fx.desat;
              ctx.filter = 'grayscale(1)';
              ctx.drawImage(ctx.canvas, 0, 0);
              ctx.filter = 'none';
              ctx.restore();
            }
            if (fx.flashAlpha > 0 && fx.flashColor) {
              ctx.save();
              ctx.globalAlpha = fx.flashAlpha;
              ctx.fillStyle   = fx.flashColor;
              ctx.fillRect(0, 0, OUT_W, OUT_H);
              ctx.restore();
            }
          }
        }

        const totalFrames  = Math.max(1, Math.round(totalDuration * FPS));
        let nextEmitIndex  = 0;
        let renderFinished = false;

        const _iosSeekMode = useMp4;
        const _nleSeekMode = isNLE;
        let _timerSeekMode = false;

        async function emitFrameAt(index) {
          let t, _inCut;
          if (isNLE) {
            const ot = index / FPS;
            const st = api.outputTimeToSourceTime?.(ot);
            _inCut   = (st == null);
            t        = _inCut ? (_nleClips[0]?.sourceStart ?? 0) : st;
          } else {
            t      = effectiveStart + (index / FPS);
            const _cuts = api.getCuts();
            _inCut = _cuts.some(c => c.end > c.start && t >= c.start && t < c.end);
          }

          if (useMp4 && !_iosSeekMode && !_timerSeekMode) {
            rv.pause();
            if (chatVid) chatVid.pause();
            if (!_inCut && Math.abs(rv.currentTime - t) > 0.002) {
              await new Promise(res => {
                rv.addEventListener('seeked', res, { once: true });
                rv.currentTime = t;
              });
              if (chatVid) chatVid.currentTime = t;
            }
          }

          if (wmVid && wmVid.duration > 0) wmVid.currentTime = (index / FPS) % wmVid.duration;
          if (_inCut) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, OUT_W, OUT_H);
          } else {
            drawCanvasFrame(t);
          }

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
              videoSource.add(index / FPS, 1 / FPS);
            } else {
              await videoSource.add(index / FPS, 1 / FPS);
              if (!_inCut && !_iosSeekMode && !_timerSeekMode && !rv.ended) {
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
          if (rv && _rvfcHandle != null && typeof rv.cancelVideoFrameCallback === 'function') {
            try { rv.cancelVideoFrameCallback(_rvfcHandle); } catch (_) {}
            _rvfcHandle = null;
          }
          if (_rvfcGuardInterval) { clearInterval(_rvfcGuardInterval); _rvfcGuardInterval = null; }

          if (!_useEngine) {
            while (nextEmitIndex < totalFrames) {
              await emitFrameAt(nextEmitIndex);
              nextEmitIndex++;
            }
          } else {
            try { _eng.pause(); } catch (_) {}
            try { _engMusicSrc?.stop(); } catch (_) {}
            try { _eng.untapAudio(_engCapDest); } catch (_) {}
          }

          if (rv) rv.pause();
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

        const _hasVFC = !!rv && typeof rv.requestVideoFrameCallback === 'function';

        if (_useEngine) {
          console.log('Render: engine-capture loop — totalFrames:', totalFrames, 'duration:', totalDuration.toFixed(2));
          let _thumbDone = false;
          // rAF runs at the display refresh (often 60Hz), so drive time-based layers
          // off the engine's OUTPUT clock, not a frame counter.
          const _engTick = () => {
            if (!frame._rendering || renderFinished) return;
            const ot = _eng.currentOutputTime();
            let st = 0; try { st = _eng.currentSourceTime(); } catch (_) { st = 0; }   // null clip in a gap → safe 0
            if (wmVid && wmVid.duration > 0) wmVid.currentTime = ot % wmVid.duration;
            // Chat follows the engine's SOURCE time so it matches the current segment in
            // the export too (cut/reorder-aware), same as the preview. Rate-converge
            // within a clip; hard-seek on a cut jump.
            if (chatVid && chatVid.readyState >= 1 && isFinite(st)) {
              const cd = chatVid.currentTime - st;
              if (Math.abs(cd) > 0.75)      { chatVid.currentTime = st; chatVid.playbackRate = 1; }
              else if (Math.abs(cd) > 0.05) { chatVid.playbackRate = Math.max(0.94, Math.min(1.06, 1 - cd * 0.5)); }
              else if (chatVid.playbackRate !== 1) { chatVid.playbackRate = 1; }
            }
            drawCanvasFrame(isFinite(st) ? st : 0);          // composite engine frame + overlays onto rc
            if (!_thumbDone && ot >= THUMB_FRAME_INDEX / FPS) {
              _thumbDone = true;
              try { thumbCtx.drawImage(rc, 0, 0, TW, TH); thumbJpegBlob = _jpegBlobFromCanvas(thumbC, 0.88); }
              catch (e) { console.warn('Render: thumbnail capture failed', e); }
            }
            nextEmitIndex = Math.min(totalFrames, Math.round(ot * FPS));
            onProgress?.(Math.min(1, Math.max(0, ot / totalDuration)));
            // Stop just before the engine loops back to 0 (it auto-loops at the end).
            if (ot >= totalDuration - (1.5 / FPS)) { finalizeRender(); return; }
            requestAnimationFrame(_engTick);
          };
          requestAnimationFrame(_engTick);

        } else if (_iosSeekMode || _nleSeekMode) {
          rv.pause();
          if (chatVid) chatVid.pause();
          console.log('Render: seek-based capture — totalFrames:', totalFrames,
            _isIOS ? '(iOS)' : isNLE ? '(NLE)' : '(desktop Mediabunny)');
          (async () => {
            try {
              for (let i = 0; i < totalFrames; i++) {
                const t = isNLE
                  ? (api.outputTimeToSourceTime?.(i / FPS) ?? (_nleClips[0]?.sourceStart ?? 0))
                  : (effectiveStart + i / FPS);
                const _ss = isInSource ? gpVideo : rv;
                if (Math.abs(_ss.currentTime - t) >= 0.001) {
                  await new Promise(res => {
                    _ss.addEventListener('seeked', res, { once: true });
                    _ss.currentTime = t;
                  });
                }
                // Await the chat seek too — iOS draws a stale/blank frame if we drawImage(chatVid)
                // before its seek has decoded (a never-played, only-seeked video has no frame at all).
                if (chatVid && Math.abs(chatVid.currentTime - t) >= 0.001) {
                  await Promise.race([
                    new Promise(res => { chatVid.addEventListener('seeked', res, { once: true }); chatVid.currentTime = t; }),
                    new Promise(res => setTimeout(res, 500)),
                  ]);
                }
                await emitFrameAt(i);
                nextEmitIndex = i + 1;
              }
              finalizeRender();
            } catch (e) { cleanup(); reject(e); }
          })();

        } else if (_hasVFC && !_nleSeekMode) {
          console.log('Render: using requestVideoFrameCallback');
          let _lastPumpPromise = Promise.resolve();
          let _lastRvfcFiredAt = Date.now();
          let _rvfcEverFired   = false;

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
            _rvfcHandle = gpVideo.requestVideoFrameCallback(onVideoFrame);
          };
          _rvfcHandle = gpVideo.requestVideoFrameCallback(onVideoFrame);

        } else {
          console.warn('Render: rVFC unavailable — timer loop');
          startTimerLoop();
        }

        function startTimerLoop() {
          _timerSeekMode = true;
          rv.pause();
          if (chatVid) chatVid.pause();
          console.log('Render: [timer] seek loop — totalFrames:', totalFrames);
          (async () => {
            try {
              for (; nextEmitIndex < totalFrames; nextEmitIndex++) {
                if (!frame._rendering || renderFinished) return;
                const t = isNLE
                  ? (api.outputTimeToSourceTime?.(nextEmitIndex / FPS) ?? (_nleClips[0]?.sourceStart ?? 0))
                  : (effectiveStart + nextEmitIndex / FPS);
                if (Math.abs(rv.currentTime - t) >= 0.001) {
                  await Promise.race([
                    new Promise(res => {
                      rv.addEventListener('seeked', res, { once: true });
                      rv.currentTime = t;
                    }),
                    new Promise(res => setTimeout(res, 1000)),
                  ]);
                }
                // Await the chat seek too (iOS won't have a decoded frame otherwise → blank chat).
                if (chatVid && Math.abs(chatVid.currentTime - t) >= 0.001) {
                  await Promise.race([
                    new Promise(res => { chatVid.addEventListener('seeked', res, { once: true }); chatVid.currentTime = t; }),
                    new Promise(res => setTimeout(res, 500)),
                  ]);
                }
                await emitFrameAt(nextEmitIndex);
              }
              if (!renderFinished) finalizeRender();
            } catch (e) { cleanup(); reject(e); }
          })();
        }

        console.log('Render: capture loop started — totalFrames:', totalFrames);
      };

      if (_useEngine) {
        _onSeeked();                                   // engine path: no rv preroll needed
      } else {
        console.log('Render: seeking to preroll', prerollStart.toFixed(3));
        rv.currentTime      = prerollStart;
        gpVideo.currentTime = prerollStart;
        if (chatVid) chatVid.currentTime = prerollStart;
        rv.addEventListener('seeked', _onSeeked, { once: true });
      }
    });
  }

  function drawPill(ctx, px, py, pw, ph, radius, bg, borderW, borderC, shadow, opacity) {
    ctx.save();
    if (opacity < 1) ctx.globalAlpha = opacity;
    // shadow may be an array of box-shadows (CSS list) or a single object (back-compat) or null.
    // CSS paints the FIRST-listed shadow on top → iterate in REVERSE so the first is drawn last.
    const shadows = Array.isArray(shadow) ? shadow : (shadow ? [shadow] : []);
    for (let i = shadows.length - 1; i >= 0; i--) {
      const sh = shadows[i];
      ctx.save();
      ctx.shadowColor   = sh.color;
      ctx.shadowOffsetX = sh.offsetX;
      ctx.shadowOffsetY = sh.offsetY;
      ctx.shadowBlur    = sh.blur;
      ctx.fillStyle     = bg;
      roundRect(ctx, px, py, pw, ph, radius);
      ctx.fill();          // this fill casts the shadow; the crisp fill below sits on top of all shadow passes
      ctx.restore();
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
    // textShadow may be an array of shadows (CSS list), a single object (back-compat), or null.
    // CSS paints the FIRST-listed shadow on top → iterate in REVERSE so the first is drawn last. Each
    // pass fills the glyph in the shadow colour (which casts the offset shadow); the real fill below
    // covers those intermediate glyphs, leaving only the offset shadows + the crisp top fill.
    const shadows = Array.isArray(textShadow) ? textShadow : (textShadow ? [textShadow] : []);
    for (let i = shadows.length - 1; i >= 0; i--) {
      const sh = shadows[i];
      ctx.save();
      ctx.fillStyle     = sh.color;
      ctx.shadowColor   = sh.color;
      ctx.shadowOffsetX = sh.offsetX;
      ctx.shadowOffsetY = sh.offsetY;
      ctx.shadowBlur    = sh.blur;
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

  // MUST mirror canvas-api.js _subAnim so the export's caption motion matches the preview.
  function _subAnim(styleId, tMs) {
    if (!styleId) return { scale: 1, dy: 0 };
    const n = parseInt(String(styleId).replace(/\D/g, ''), 10);
    if (!n) return { scale: 1, dy: 0 };
    const c = x => (x < 0 ? 0 : x > 1 ? 1 : x);
    const kind = (n - 1) % 3;
    if (kind === 0) { const e = 1 - Math.pow(1 - c(tMs / 130), 3); return { scale: 0.86 + 0.14 * e, dy: 0 }; }
    if (kind === 1) { const e = 1 - Math.pow(1 - c(tMs / 160), 3); return { scale: 0.97 + 0.03 * e, dy: 0.16 * (1 - e) }; }
    const p = c(tMs / 200);
    const s = p < 0.6 ? 0.9 + (1.08 - 0.9) * (p / 0.6) : 1.08 - (1.08 - 1) * ((p - 0.6) / 0.4);
    return { scale: s, dy: 0 };
  }

  function renderSubWordAtY(ctx, text, y, ts, anim) {
    const font = `${ts.sFontWeight} ${ts.sFontSize}px ${ts.sFontFamily}`;
    ctx.font         = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;

    const tw = ctx.measureText(text).width;
    const pw = tw + ts.sPillPadLeft + ts.sPillPadRight;
    const ph = ts.sLineHeight + ts.sPillPadTop + ts.sPillPadBottom;
    const px = (OUT_W - pw) / 2;
    const cx = OUT_W / 2, cy = y + ph / 2;
    ctx.save();
    if (anim && (anim.scale !== 1 || anim.dy)) {                 // match the preview's entry motion
      ctx.translate(cx, cy + (anim.dy || 0) * ts.sFontSize);
      ctx.scale(anim.scale, anim.scale);
      ctx.translate(-cx, -cy);
    }
    drawPill(ctx, px, y, pw, ph, ts.sPillRadius, ts.sPillActiveBg,
      ts.sPillActiveBorderW, ts.sPillActiveBorderC,
      ts.sPillActiveShadow, ts.sPillActiveOpacity);
    ctx.font      = font;
    ctx.textAlign = 'center';
    if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;
    drawStyledText(ctx, text, OUT_W / 2, y + ph / 2,
      ts.sActiveColor, ts.sActiveTextShadow,
      ts.sActiveStrokeWidth, ts.sActiveStrokeColor);
    ctx.restore();
    ctx.letterSpacing = '0px';
  }

  function renderSubChunkAtY(ctx, chunk, activeIdx, y, ts, anim) {
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
      const cx = x + pw / 2, cy = y + ph / 2;
      ctx.save();
      if (isActive && anim && (anim.scale !== 1 || anim.dy)) {   // match the preview's entry motion
        ctx.translate(cx, cy + (anim.dy || 0) * ts.sFontSize);
        ctx.scale(anim.scale, anim.scale);
        ctx.translate(-cx, -cy);
      }
      drawPill(ctx, x, y, pw, ph, ts.sPillRadius,
        isActive ? ts.sPillActiveBg      : ts.sPillBg,
        isActive ? ts.sPillActiveBorderW : ts.sPillBorderW,
        isActive ? ts.sPillActiveBorderC : ts.sPillBorderC,
        isActive ? ts.sPillActiveShadow  : ts.sPillShadow,
        isActive ? ts.sPillActiveOpacity : ts.sPillOpacity);
      ctx.font      = font;
      ctx.textAlign = 'center';
      if (ts.sLetterSpacing) ctx.letterSpacing = `${ts.sLetterSpacing}px`;
      drawStyledText(ctx, m.text, cx, cy,
        isActive ? ts.sActiveColor       : ts.sColor,
        isActive ? ts.sActiveTextShadow  : ts.sTextShadow,
        isActive ? ts.sActiveStrokeWidth : ts.sStrokeWidth,
        isActive ? ts.sActiveStrokeColor : ts.sStrokeColor);
      ctx.restore();
      x += pw + wordGap;
    }
    ctx.letterSpacing = '0px';
  }

  let _rendering     = false;
  let _progress      = 0;
  let _status        = 'idle';
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

  // Wait for the engine-capture render path to be ready before rendering. An early
  // trigger — before the WebCodecs engine has taken over the NLE timeline, or before
  // the saved clips are restored — would fall back to the legacy path (slow-mo /
  // no audio). Resolves as soon as the engine owns an NLE timeline, OR once the
  // preview path has settled WITHOUT the engine (unsupported / flag-off → legacy is
  // the best available). Bounded so it can never hang the render button.
  function _awaitEngineRenderReady(timeoutMs = 20000) {
    const api = window.canvasAPI;
    const ready = () => {
      const clips    = (api?.getOutputClips?.()?.length || 0) > 0;
      const engineUp = !!window.wcEngine?.isActive?.();
      const settled  = window.wcPreview?.isReady?.() === true;
      return (engineUp && clips) || (settled && !engineUp);
    };
    if (ready()) return Promise.resolve();
    console.log('Render: waiting for engine-capture path to be ready…');
    const t0 = Date.now();
    return new Promise(res => {
      const tick = () => {
        if (ready())                       { console.log('Render: engine path ready');                 return res(); }
        if (Date.now() - t0 > timeoutMs)   { console.warn('Render: readiness wait timed out — proceeding'); return res(); }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  window.renderClip = async function () {
    if (_rendering) { console.warn('Render: blocked — already rendering'); return; }

    _rendering = true;
    _progress  = 0;
    _status    = 'rendering';
    window.dispatchEvent(new CustomEvent('renderStateChange',
      { detail: { status: 'rendering', progress: 0 } }));

    // Don't render until the engine-capture path is ready (else early triggers use the
    // legacy path → slow-mo / no audio). Button already shows "rendering" during the wait.
    await _awaitEngineRenderReady();

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
      document.querySelectorAll('video[style*="-9999px"]').forEach(v => {
        try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (_) {}
      });
    }
  };

})();