(() => {
  'use strict';
  const FRAME_US        = 1e6 / 30;
  const BUFFER_AHEAD_US = 500000;
  const MAX_DECODE_QUEUE = 8;
  const JUMP_US         = 350000;
  const MP4BOX_SRC      = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';
  const FLAG = () => window.USE_WEBCODECS_PREVIEW !== false;
  const SUPPORTED = typeof window.VideoDecoder === 'function'
                 && typeof window.EncodedVideoChunk === 'function';
  const log = (...a) => console.log('[wc]', ...a);

  // ── Motion-tracker tunables (live-editable: window.wcTrackCfg.xxx = …) ───────
  // analyze()/relink() read these as defaults each call, so tweak then re-run.
  const TRACK = {
    fps:        8,      // detection/track samples per second
    longSide:   512,    // face-detection input resolution (longest side, px)
    conf:       0.4,    // BlazeFace min confidence
    enhance:    '',     // canvas filter before detection, e.g. 'brightness(1.4) contrast(1.15)'
    seedRadius: 0.10,   // a face this close to the click → FACE mode, else PATCH mode
    snapR:      0.12,   // face mode: snap to a detection within this of the patch backbone
    patchFrac:  0.14,   // patch template size (fraction of frame width)
    searchFrac: 0.10,   // patch search window radius (fraction of frame width)
    step:       2,      // patch search step (px @ 256-wide)
    adapt:      0,      // patch template adaptation per frame (0..~0.05) — drift vs stick
    lostThresh: 40,     // mean abs pixel diff above which the patch is "lost"
    recenter:   true,   // on lost (e.g. camera change) → ease back to centre vs hold
    autoOffRatio: 0.85, // if the subject is lost for ≥ this fraction → tracking toggles OFF (failed seed)
    // pure detection-link fallback (forceMode:'faceonly'):
    gate: 0.18, maxGate: 0.33, slack: 0.8, seedWin: 1.0, sizeW: 1.2,
  };
  window.wcTrackCfg = TRACK;

  let _mp4boxPromise = null;
  function loadMp4box() {
    if (window.MP4Box) return Promise.resolve();
    if (_mp4boxPromise) return _mp4boxPromise;
    _mp4boxPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = MP4BOX_SRC;
      s.onload = () => res();
      s.onerror = () => rej(new Error('mp4box failed to load'));
      document.head.appendChild(s);
    });
    return _mp4boxPromise;
  }
  const _demuxCache = new Map();
  function getDescription(file, track) {
    const trak = file.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(ds);
        return new Uint8Array(ds.buffer, 8);
      }
    }
    throw new Error('no codec description (avcC) in source');
  }
  const _IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
               || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const AUDIO_SUPPORTED = typeof window.AudioDecoder === 'function'
                       && typeof window.EncodedAudioChunk === 'function';
  let _audioCtx = null;
  const audioCtx = () => _audioCtx || (_audioCtx = new (window.AudioContext || window.webkitAudioContext)());
  let _audioUnlocked = false;
  function _unlockAudio() {
    const ctx = _audioCtx;
    if (!ctx || _audioUnlocked) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch (_) {}
    if (ctx.state === 'running') _audioUnlocked = true;
  }
  ['pointerdown', 'touchend', 'mousedown', 'keydown'].forEach(ev =>
    window.addEventListener(ev, _unlockAudio, { capture: true, passive: true }));
  function getAudioConfig(file, atrack) {
    const trak = file.getTrackById(atrack.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    let description;
    const esds = entry && entry.esds;
    if (esds && esds.esd) {
      const dsi = esds.esd.descs?.[0]?.descs?.[0];
      if (dsi?.data) description = dsi.data;
    }
    return { codec: atrack.codec, sampleRate: atrack.audio.sample_rate, numberOfChannels: atrack.audio.channel_count,
             description, esds, timescale: atrack.timescale };
  }
  async function decodeAudioBuffer(audioSamples, audioConfig) {
    const out = [];
    const dec = new AudioDecoder({ output: d => out.push(d), error: e => console.warn('[wc] audio decode', e) });
    const cfg = { codec: audioConfig.codec, sampleRate: audioConfig.sampleRate, numberOfChannels: audioConfig.numberOfChannels };
    if (audioConfig.description) cfg.description = audioConfig.description;
    dec.configure(cfg);
    for (const s of audioSamples) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.ts, duration: s.dur, data: s.data }));
    await dec.flush(); dec.close();
    if (!out.length) throw new Error('no audio frames decoded');
    const ch = out[0].numberOfChannels, sr = out[0].sampleRate;
    const total = out.reduce((n, d) => n + d.numberOfFrames, 0);
    const buf = audioCtx().createBuffer(ch, total, sr);
    let off = 0;
    for (const d of out) {
      const n = d.numberOfFrames;
      for (let c = 0; c < ch; c++) {
        const tmp = new Float32Array(n);
        d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        buf.getChannelData(c).set(tmp, off);
      }
      off += n; d.close();
    }
    return buf;
  }
  async function remuxAudioToBuffer(audioSamples, audioConfig) {
    await loadMp4box();
    if (!audioConfig.esds) throw new Error('no esds — cannot remux audio');
    const out = MP4Box.createFile();
    const id = out.addTrack({
      type: 'mp4a',
      timescale:     audioConfig.timescale,
      samplerate:    audioConfig.sampleRate,
      channel_count: audioConfig.numberOfChannels,
      samplesize:    16,
      description:   audioConfig.esds,
      hdlr:          'soun',
    });
    const base = audioSamples[0]?._dts ?? 0;
    for (const s of audioSamples) {
      out.addSample(id, s.data, { duration: s._sdur, dts: s._dts - base, cts: (s._cts ?? s._dts) - base, is_sync: s._sync });
    }
    return audioCtx().decodeAudioData(out.getBuffer().slice(0));
  }
  function demux(url, win) {
    const key = win ? `${url}#${win.start}-${win.end}` : url;
    if (_demuxCache.has(key)) return _demuxCache.get(key);
    const p = win ? demuxWindowed(url, win.start, win.end) : demuxWhole(url);
    _demuxCache.set(key, p);
    p.catch(() => _demuxCache.delete(key));
    return p;
  }
  function _mkVideoSample(s) {
    return { type: s.is_sync ? 'key' : 'delta', ts: 1e6 * s.cts / s.timescale, dur: 1e6 * s.duration / s.timescale, data: s.data };
  }
  function _mkAudioSample(s) {
    return { ts: 1e6 * s.cts / s.timescale, dur: 1e6 * s.duration / s.timescale, data: s.data,
             _dts: s.dts, _cts: s.cts ?? s.dts, _sdur: s.duration, _sync: s.is_sync !== false };
  }
  function _videoConfig(file, vtrack) {
    return {
      codec: vtrack.codec,
      codedWidth:  vtrack.video.width  || vtrack.track_width,
      codedHeight: vtrack.video.height || vtrack.track_height,
      description: getDescription(file, vtrack),
      optimizeForLatency: true,
    };
  }
  async function _finishMedia(url, samples, audioSamples, audioConfig, config, durationUs, baseSec, tag) {
    const keyIdx = samples.map((s, i) => s.type === 'key' ? i : -1).filter(i => i >= 0);
    let audioBuffer = null;
    if (audioConfig && audioSamples.length) {
      try {
        audioBuffer = AUDIO_SUPPORTED
          ? await decodeAudioBuffer(audioSamples, audioConfig)
          : await remuxAudioToBuffer(audioSamples, audioConfig);
      } catch (e) { console.warn('[wc] audio decode failed (video-only clock):', e); }
    }
    const audioBaseSec = audioBuffer ? (audioSamples[0].ts / 1e6) : 0;
    log(`demuxed ${tag} ${url.split('/').pop()} — ${samples.length} frames, ${keyIdx.length} keyframes, ${config.codec}` +
        (audioBuffer ? `, audio ${audioBuffer.numberOfChannels}ch@${audioBuffer.sampleRate} ${audioBuffer.duration.toFixed(1)}s @${audioBaseSec.toFixed(1)}s` : ', no audio'));
    return { samples, keyIdx, config, durationUs, audioBuffer, audioBaseSec };
  }
  async function demuxWhole(url) {
    await loadMp4box();
    const r = await fetch(url);
    if (!r.ok) throw new Error('source fetch HTTP ' + r.status);
    const ab = await r.arrayBuffer();
    const file = MP4Box.createFile();
    const samples = [], audioSamples = [];
    let vtrack = null, atrack = null, config = null, audioConfig = null, durationUs = 0, vDone = false, aDone = false;
    const done = new Promise((res, rej) => {
      const check = () => { if (vDone && (aDone || !atrack)) res(); };
      file.onError = e => rej(new Error('mp4box: ' + e));
      file.onReady = info => {
        vtrack = info.videoTracks[0];
        atrack = info.audioTracks[0] || null;
        if (!vtrack) return rej(new Error('no video track in source'));
        durationUs = (info.duration / info.timescale) * 1e6;
        config = _videoConfig(file, vtrack);
        file.setExtractionOptions(vtrack.id, null, { nbSamples: Infinity });
        if (atrack) { audioConfig = getAudioConfig(file, atrack); file.setExtractionOptions(atrack.id, null, { nbSamples: Infinity }); }
        else { atrack = null; }
        file.start();
      };
      file.onSamples = (id, user, list) => {
        if (vtrack && id === vtrack.id) {
          for (const s of list) samples.push(_mkVideoSample(s));
          if (samples.length >= vtrack.nb_samples) { vDone = true; check(); }
        } else if (atrack && id === atrack.id) {
          for (const s of list) audioSamples.push(_mkAudioSample(s));
          if (audioSamples.length >= atrack.nb_samples) { aDone = true; check(); }
        }
      };
    });
    ab.fileStart = 0;
    file.appendBuffer(ab);
    file.flush();
    await done;
    const media = await _finishMedia(url, samples, audioSamples, audioConfig, config, durationUs, 0, 'live');
    if (!media.audioBuffer) {
      try {
        media.audioBuffer = await audioCtx().decodeAudioData(ab.slice(0));
        media.audioBaseSec = 0;
        log(`audio via decodeAudioData fallback — ${media.audioBuffer.numberOfChannels}ch@${media.audioBuffer.sampleRate} ${media.audioBuffer.duration.toFixed(1)}s`);
      } catch (e) { console.warn('[wc] decodeAudioData fallback failed (video-only):', e); }
    }
    return media;
  }
  async function demuxWindowed(url, fromSec, toSec) {
    await loadMp4box();
    const CHUNK = 512 * 1024, CAP = 350 * 1024 * 1024;
    const loMargin = 35, hiMargin = 5;
    const keepLo = Math.max(0, fromSec - loMargin), keepHi = toSec + hiMargin;
    const file = MP4Box.createFile();
    const samples = [], audioSamples = [];
    let vtrack = null, atrack = null, config = null, audioConfig = null, durationUs = 0;
    let fileSize = 0, vRaw = 0, aRaw = 0, covered = false, fatal = null;
    let seekOffset = -1, seekPending = false;
    file.onError = e => { fatal = new Error('mp4box: ' + e); };
    file.onReady = info => {
      vtrack = info.videoTracks[0];
      atrack = info.audioTracks[0] || null;
      if (!vtrack) { fatal = new Error('no video track in source'); return; }
      durationUs = (info.duration / info.timescale) * 1e6;
      config = _videoConfig(file, vtrack);
      if (atrack) audioConfig = getAudioConfig(file, atrack);
      file.setExtractionOptions(vtrack.id, null, { nbSamples: 50 });
      if (atrack) file.setExtractionOptions(atrack.id, null, { nbSamples: 50 });
      file.start();
      const sk = file.seek(Math.max(0, fromSec - 1), true);
      seekOffset = sk.offset; seekPending = true;
      log(`vod: moov parsed; ${config.codedWidth}x${config.codedHeight} ${(durationUs/1e6).toFixed(0)}s; seek ${(fromSec-1).toFixed(0)}s → ${(sk.offset/1e6).toFixed(1)}MB`);
    };
    file.onSamples = (id, user, list) => {
      if (vtrack && id === vtrack.id) {
        vRaw += list.length;
        for (const s of list) { const t = s.cts / s.timescale; if (t >= keepLo && t <= keepHi) samples.push(_mkVideoSample(s)); }
        if (samples.length && samples[samples.length - 1].ts / 1e6 >= toSec) covered = true;
      } else if (atrack && id === atrack.id) {
        aRaw += list.length;
        for (const s of list) { const t = s.cts / s.timescale; if (t >= keepLo && t <= keepHi) audioSamples.push(_mkAudioSample(s)); }
      }
    };
    let nextStart = 0, fetched = 0, chunks = 0;
    while (!covered) {
      if (fatal) throw fatal;
      if (fileSize && nextStart >= fileSize) break;
      if (fetched > CAP) throw new Error(`vod window not covered within ${(CAP/1e6)|0}MB (rawV=${vRaw} keptV=${samples.length})`);
      const end = Math.min((fileSize || Number.MAX_SAFE_INTEGER) - 1, nextStart + CHUNK - 1);
      const r = await fetch(url, { headers: { Range: `bytes=${nextStart}-${end}` } });
      if (r.status !== 206 && r.status !== 200) throw new Error('range fetch HTTP ' + r.status);
      if (!fileSize) { const cr = r.headers.get('content-range'); fileSize = cr ? parseInt(cr.split('/')[1], 10) : 0; }
      const buf = await r.arrayBuffer();
      if (!buf.byteLength) break;
      fetched += buf.byteLength;
      buf.fileStart = nextStart;
      const ret = file.appendBuffer(buf);
      if (seekPending) { nextStart = seekOffset; seekPending = false; }
      else if (typeof ret === 'number' && ret > nextStart) nextStart = ret;
      else nextStart += buf.byteLength;
      if ((++chunks % 15) === 0) log(`vod: ${(fetched/1e6).toFixed(0)}MB raw(v=${vRaw},a=${aRaw}) kept(v=${samples.length},a=${audioSamples.length}) next=${(nextStart/1e6).toFixed(1)}MB`);
      await Promise.resolve();
    }
    file.flush();
    if (fatal) throw fatal;
    if (!samples.length) throw new Error('windowed demux produced no samples for ' + fromSec + '-' + toSec + 's');
    log(`vod: window covered — ${samples.length} video, ${audioSamples.length} audio samples, ${(fetched/1e6).toFixed(0)}MB fetched`);
    return _finishMedia(url, samples, audioSamples, audioConfig, config, durationUs, fromSec, 'vod');
  }
  window.wcThumbs = { ready: false, times: [], frames: [], frameAt() { return null; } };
  window.wcTimeLayers = window.wcTimeLayers || [];
  const _thumbCache = new Map();
  async function buildThumbBitmaps(media) {
    const { samples, keyIdx, config } = media;
    if (!keyIdx.length) return null;
    const times  = keyIdx.map(i => samples[i].ts / 1e6);
    const frames = new Array(keyIdx.length).fill(null);
    const pending = [];
    let n = 0;
    const dec = new VideoDecoder({
      output: f => {
        const idx = n++;
        pending.push(
          createImageBitmap(f, { resizeWidth: 240, resizeHeight: 135, resizeQuality: 'low' })
            .catch(() => createImageBitmap(f).catch(() => null))
            .then(b => { frames[idx] = b; })
            .finally(() => { try { f.close(); } catch (_) {} })
        );
      },
      error: e => console.warn('[wc] thumb decode', e),
    });
    dec.configure(config);
    for (const i of keyIdx) {
      if (dec.decodeQueueSize > 12) await new Promise(r => setTimeout(r, 0));
      const s = samples[i];
      dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: s.ts, duration: s.dur, data: s.data }));
    }
    await dec.flush();
    try { dec.close(); } catch (_) {}
    await Promise.all(pending);
    return { times, frames };
  }
  function _installThumbs(pack) {
    Object.assign(window.wcThumbs, {
      ready: true, times: pack.times, frames: pack.frames,
      frameAt(sec) {
        const t = pack.times; if (!t.length) return null;
        let best = 0; for (let k = 0; k < t.length; k++) { if (t[k] <= sec) best = k; else break; }
        return pack.frames[best] || null;
      },
    });
    window.dispatchEvent(new CustomEvent('wcThumbsReady'));
  }
  async function buildThumbsFor(url, media) {
    if (_thumbCache.has(url)) { _installThumbs(_thumbCache.get(url)); return; }
    try {
      const pack = await buildThumbBitmaps(media);
      if (!pack) return;
      _thumbCache.set(url, pack);
      _installThumbs(pack);
      log(`thumbs: ${pack.frames.filter(Boolean).length} keyframe bitmaps ready`);
    } catch (e) { console.warn('[wc] thumb build failed', e); }
  }
  function ensureCanvas(gpVideo, config) {
    const parent = gpVideo.parentElement;
    if (getComputedStyle(parent).isolation !== 'isolate') parent.style.isolation = 'isolate';
    let cv = parent.querySelector('.wc_gameplay_canvas');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.className = 'wc_gameplay_canvas';
      Object.assign(cv.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%', display: 'block', pointerEvents: 'none',
      });
      const gpZ = parseInt(getComputedStyle(gpVideo).zIndex) || 0;
      cv.style.zIndex = String(gpZ + 2);
      parent.appendChild(cv);
    }
    if (cv.width !== config.codedWidth)  cv.width  = config.codedWidth;
    if (cv.height !== config.codedHeight) cv.height = config.codedHeight;
    return cv;
  }
  function mirrorGeometry(gpVideo, cv) {
    const s = gpVideo.style;
    cv.style.width     = s.width  || '100%';
    cv.style.height    = s.height || '100%';
    cv.style.left      = s.left   || '0';
    cv.style.top       = s.top    || '0';
    cv.style.transform = s.transform || '';
  }
  function mirrorComputed(gpVideo, cv) {
    const cs = getComputedStyle(gpVideo);
    cv.style.objectFit       = cs.objectFit;
    cv.style.objectPosition  = cs.objectPosition;
    cv.style.borderRadius    = cs.borderRadius;
    cv.style.transformOrigin = cs.transformOrigin;
  }
  class Deck {
    constructor(samples, keyIdx, config) {
      this.samples = samples; this.keyIdx = keyIdx; this.config = config;
      this.decoder = null; this.presentQ = []; this.feedPos = 0;
      this.startTs = 0; this.ready = false; this._target = 0;
    }
    _kf(ts) { let k = this.keyIdx[0]; for (const i of this.keyIdx) { if (this.samples[i].ts <= ts) k = i; else break; } return k; }
    prime(startTs) {
      this.startTs = startTs;
      this.feedPos = this._kf(startTs);
      this._target = startTs + BUFFER_AHEAD_US;
      this.decoder = new VideoDecoder({
        output: f => this._onFrame(f),
        error: e => console.warn('[wc] decode error', e),
      });
      this.decoder.configure(this.config);
      this._feed();
    }
    _onFrame(f) {
      if (f.timestamp < this.startTs - FRAME_US) { f.close(); return; }
      let lo = 0, hi = this.presentQ.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.presentQ[m].timestamp < f.timestamp) lo = m + 1; else hi = m; }
      this.presentQ.splice(lo, 0, f);
      this.ready = true;
    }
    async _feed() {
      while (this.decoder && this.feedPos < this.samples.length) {
        const s = this.samples[this.feedPos];
        if (this.ready && s.ts > this._target) { await new Promise(r => setTimeout(r, 4)); continue; }
        if (this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE) { await new Promise(r => setTimeout(r, 0)); continue; }
        this.feedPos++;
        this.decoder.decode(new EncodedVideoChunk({ type: s.type, timestamp: s.ts, duration: s.dur, data: s.data }));
      }
    }
    extendTo(ct) { const want = ct + BUFFER_AHEAD_US; if (want > this._target) this._target = want; }
    present(ct) {
      let painted = null;
      while (this.presentQ.length && this.presentQ[0].timestamp <= ct + FRAME_US * 0.5) {
        if (painted) painted.close();
        painted = this.presentQ.shift();
      }
      return painted;
    }
    destroy() {
      if (this.decoder) { try { this.decoder.close(); } catch (_) {} this.decoder = null; }
      this.presentQ.forEach(f => f.close()); this.presentQ = [];
    }
  }
  function createEngine(gpVideo, cv, media) {
    const ctx = cv.getContext('2d');
    const { samples, keyIdx, config, audioBuffer } = media;
    const audioBaseSec = media.audioBaseSec || 0;
    const actx = audioCtx();
    const gain = actx.createGain();
    gain.connect(actx.destination);
    const newDeck = () => new Deck(samples, keyIdx, config);
    const listeners = { play: [], pause: [] };
    const emit = ev => { for (const cb of listeners[ev]) { try { cb(); } catch (_) {} } };
    function clipsList() {
      const c = window.canvasAPI?.getOutputClips?.() || [];
      if (c.length) return c;
      const win = window.canvasAPI?.getSourceWindow?.();
      const s = win ? win.start : 0;
      const e = win ? win.end   : (media.durationUs / 1e6);
      return [{ id: '__whole__', sourceStart: s, sourceEnd: e, outputStart: 0, outputEnd: e - s }];
    }
    const outDuration = () => {
      const d = window.canvasAPI?.getOutputDuration?.();
      if (isFinite(d) && d > 0) return d;
      const c = clipsList(); return c[c.length - 1].outputEnd;
    };
    function clipAtOut(ot) {
      const c = clipsList();
      for (const x of c) if (ot >= x.outputStart && ot < x.outputEnd) return x;
      const EPS = 0.05;
      for (const x of c) if (ot >= x.outputStart - EPS && ot < x.outputEnd + EPS) return x;
      return null;
    }
    let playing = false, otAnchor = 0, ctxAnchor = 0, pauseOt = 0;
    let scheduled = [];
    const curOt = () => playing ? Math.min(outDuration(), otAnchor + (actx.currentTime - ctxAnchor)) : pauseOt;
    function stopAudio() { for (const s of scheduled) { try { s.stop(); } catch (_) {} } scheduled = []; }
    function scheduleAudioFrom(fromOt) {
      stopAudio();
      if (!audioBuffer) return;
      const now = actx.currentTime;
      for (const clip of clipsList()) {
        if (clip.outputEnd <= fromOt) continue;
        let off = clip.sourceStart - audioBaseSec, dur = clip.sourceEnd - clip.sourceStart, when = now + (clip.outputStart - fromOt);
        if (clip.outputStart < fromOt) { const into = fromOt - clip.outputStart; off += into; dur -= into; when = now; }
        off = Math.max(0, off);
        if (off + dur > audioBuffer.duration) dur = audioBuffer.duration - off;
        if (dur <= 0.001) continue;
        const src = actx.createBufferSource();
        src.buffer = audioBuffer; src.connect(gain);
        try { src.start(when, off, dur); } catch (_) {}
        scheduled.push(src);
      }
    }
    function play() {
      if (playing) return;
      otAnchor = pauseOt; ctxAnchor = actx.currentTime; playing = true;
      scheduleAudioFrom(otAnchor);
      emit('play');
      if (actx.state !== 'running') {
        actx.resume().then(() => {
          if (!playing) return;
          otAnchor = pauseOt; ctxAnchor = actx.currentTime;
          scheduleAudioFrom(pauseOt);
        }).catch(() => {});
      }
    }
    function pause() {
      if (!playing) return;
      pauseOt = curOt(); playing = false; stopAudio(); emit('pause');
    }
    function seekOutput(ot) {
      ot = Math.max(0, Math.min(outDuration(), ot));
      pauseOt = ot; otAnchor = ot; ctxAnchor = actx.currentTime;
      _needReseek = true;
      if (playing) scheduleAudioFrom(ot);
    }
    let running = false, rafId = 0, lastDrawnTs = -1, curClipId = null, _needReseek = false;
    let main = null, standby = null, standbyTs = null, armThrottle = 0, styleThrottle = 0;
    const draw = f => { if (f.timestamp !== lastDrawnTs) { ctx.drawImage(f, 0, 0); lastDrawnTs = f.timestamp; } };
    function nextNonContiguousStartUs() {
      const c = clipsList();
      const i = c.findIndex(x => x.id === curClipId);
      if (i < 0 || i + 1 >= c.length) return null;
      const cur = c[i], nx = c[i + 1];
      if (Math.abs(nx.sourceStart - cur.sourceEnd) < 0.08) return null;
      return nx.sourceStart * 1e6;
    }
    function armStandby() {
      const t = nextNonContiguousStartUs();
      if (t == null) { if (standby) { standby.destroy(); standby = null; standbyTs = null; } return; }
      if (standby && Math.abs(standbyTs - t) < 1000) return;
      if (standby) standby.destroy();
      standby = newDeck(); standby.prime(t); standbyTs = t;
    }
    function tick() {
      if (!running) return;
      let ot = curOt();
      if (playing && ot >= outDuration() - 1e-3) { seekOutput(0); ot = 0; }
      const clip = clipAtOut(ot);
      if (!clip) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
        lastDrawnTs = -1;
      } else {
        const srcUs = (clip.sourceStart + (ot - clip.outputStart)) * 1e6;
        if (_needReseek) {
          _needReseek = false;
          if (main) main.destroy();
          main = newDeck(); main.prime(srcUs);
          curClipId = clip.id; armStandby();
        } else if (clip.id !== curClipId) {
          const prev = curClipId ? clipsList().find(c => c.id === curClipId) : null;
          const contiguous = prev && Math.abs(clip.sourceStart - prev.sourceEnd) < 0.08;
          if (!contiguous) {
            if (standby && standbyTs != null && Math.abs(clip.sourceStart * 1e6 - standbyTs) < JUMP_US && standby.ready) {
              if (main) main.destroy(); main = standby; standby = null; standbyTs = null;
              if (_debug) console.log('[wc] ✓ SEAMLESS swap →', clip.sourceStart.toFixed(2) + 's');
            } else {
              if (main) main.destroy(); main = newDeck(); main.prime(srcUs);
              if (_debug) console.log('[wc] ✗ reseek →', clip.sourceStart.toFixed(2) + 's (standby miss)');
            }
          }
          curClipId = clip.id; armStandby();
        }
        if (main) { main.extendTo(srcUs); const f = main.present(srcUs); if (f) { draw(f); f.close(); } }
        if ((armThrottle = (armThrottle + 1) % 10) === 0) armStandby();
      }
      const L = window.wcTimeLayers;
      if (L && L.length) {
        const srcSec = clip ? (clip.sourceStart + (ot - clip.outputStart)) : -1;
        for (let i = 0; i < L.length; i++) { try { L[i](srcSec, ot, clip); } catch (_) {} }
      }
      mirrorGeometry(gpVideo, cv);
      if ((styleThrottle = (styleThrottle + 1) % 15) === 0) mirrorComputed(gpVideo, cv);
      rafId = requestAnimationFrame(tick);
    }
    return {
      start(startOt, autoplay) {
        if (running) return;
        running = true; lastDrawnTs = -1; curClipId = null; _needReseek = true;
        pauseOt = Math.max(0, startOt || 0); otAnchor = pauseOt; ctxAnchor = actx.currentTime;
        mirrorGeometry(gpVideo, cv); mirrorComputed(gpVideo, cv);
        rafId = requestAnimationFrame(tick);
        if (autoplay) play();
      },
      stop() {
        running = false; cancelAnimationFrame(rafId);
        stopAudio(); playing = false;
        if (main) { main.destroy(); main = null; }
        if (standby) { standby.destroy(); standby = null; }
        standbyTs = null; lastDrawnTs = -1;
      },
      play, pause, seekOutput,
      get paused() { return !playing; },
      hasAudio: !!audioBuffer,
      outputDuration: outDuration,
      currentOutputTime: curOt,
      currentSourceTime() { const ot = curOt(); const c = clipAtOut(ot); return c.sourceStart + (ot - c.outputStart); },
      currentClipId: () => curClipId,
      currentFrameCanvas: () => cv,
      setVolume(v) { gain.gain.value = v; },
      audioContext: () => actx,
      tapAudio:   (node) => { try { gain.connect(node); }    catch (_) {} },
      untapAudio: (node) => { try { gain.disconnect(node); } catch (_) {} },
      on(ev, cb) { if (listeners[ev]) listeners[ev].push(cb); },
    };
  }
  const state = { active: false, engine: null, cv: null, gpVideo: null, prevOpacity: '', prevMuted: false, bg: null, media: null, url: null };
  const MP_BASE  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
  const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
  let _faceDetector = null;
  let _lastScan = null;
  function relinkTrack(opts = {}) {
    if (!_lastScan) { console.warn('[wc] tracker: nothing scanned yet — run analyze() first'); return null; }
    const { perFrame, gw, gh, t0, t1 } = _lastScan;
    const { track, mode } = _buildTrack(perFrame, gw, gh, { atSec: t0, ...opts });
    if (track.length) { window.wcReframe?.setTrack(track); window.wcReframe?.enable(true); }
    log(`tracker relink[${mode}]: ${track.length} pts`);
    return { points: track.length, mode, t0, t1 };
  }
  let _faceConf = null;
  let _mpClock = 0;   // monotonic timestamp for detectForVideo across analyze() runs
  async function ensureFaceDetector(conf = TRACK.conf) {
    if (_faceDetector && _faceConf === conf) return _faceDetector;
    if (_faceDetector) { try { _faceDetector.close(); } catch (_) {} _faceDetector = null; }
    const vision = await import( `${MP_BASE}/vision_bundle.mjs`);
    const { FilesetResolver, FaceDetector } = vision;
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const mk = (delegate) => FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: conf,
    });
    try { _faceDetector = await mk('GPU'); }
    catch (e) { log('face GPU delegate failed → CPU', e?.message || e); _faceDetector = await mk('CPU'); }
    _faceConf = conf;
    return _faceDetector;
  }
  function _linkTrack(perFrame, { sx, sy, atSec, gate, maxGate = 0.33, slack = 0.8, seedWin = 1.0, sizeW = 1.2 }) {
    if (!perFrame.length) return [];
    let aIdx = -1, aDet = null, aBest = Infinity;
    for (let i = 0; i < perFrame.length; i++) {
      if (Math.abs(perFrame[i].t - atSec) > seedWin) continue;
      for (const dt of perFrame[i].dets) {
        const d = (dt.cx - sx) ** 2 + (dt.cy - sy) ** 2;
        if (d < aBest) { aBest = d; aIdx = i; aDet = dt; }
      }
    }
    if (aIdx < 0) {
      let bt = Infinity;
      for (let i = 0; i < perFrame.length; i++) {
        if (!perFrame[i].dets.length) continue;
        const d = Math.abs(perFrame[i].t - atSec);
        if (d < bt) { bt = d; aIdx = i; }
      }
      if (aIdx < 0) return [];
      let bd = Infinity;
      for (const dt of perFrame[aIdx].dets) { const d = (dt.cx - sx) ** 2 + (dt.cy - sy) ** 2; if (d < bd) { bd = d; aDet = dt; } }
    }
    const pick = (dets, p) => {
      let best = null, bc = Infinity;
      for (const dt of dets) {
        const c = Math.hypot(dt.cx - p.cx, dt.cy - p.cy) + sizeW * Math.abs(dt.w - p.w);
        if (c < bc) { bc = c; best = dt; }
      }
      return { best, cost: bc };
    };
    const out = [{ t: perFrame[aIdx].t, cx: aDet.cx, cy: aDet.cy, w: aDet.w }];
    let prev = aDet, prevT = perFrame[aIdx].t;
    for (let i = aIdx + 1; i < perFrame.length; i++) {
      const { best, cost } = pick(perFrame[i].dets, prev);
      const eff = Math.min(maxGate, gate + slack * (perFrame[i].t - prevT));
      if (best && cost <= eff) { out.push({ t: perFrame[i].t, cx: best.cx, cy: best.cy, w: best.w }); prev = best; prevT = perFrame[i].t; }
    }
    prev = aDet; prevT = perFrame[aIdx].t;
    for (let i = aIdx - 1; i >= 0; i--) {
      const { best, cost } = pick(perFrame[i].dets, prev);
      const eff = Math.min(maxGate, gate + slack * (prevT - perFrame[i].t));
      if (best && cost <= eff) { out.unshift({ t: perFrame[i].t, cx: best.cx, cy: best.cy, w: best.w }); prev = best; prevT = perFrame[i].t; }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  // Generic patch tracker (skin-tone / content agnostic): SAD template match in a
  // search window around the previous position, walked forward + backward from the seed.
  function _extract(g, gw, gh, cx, cy, half) {
    const P = 2 * half + 1;
    cx = Math.min(gw - half - 1, Math.max(half, cx));
    cy = Math.min(gh - half - 1, Math.max(half, cy));
    const t = new Float32Array(P * P);
    let k = 0;
    for (let y = -half; y <= half; y++) { const row = (cy + y) * gw + cx; for (let x = -half; x <= half; x++) t[k++] = g[row + x]; }
    return { t, cx, cy };
  }
  function _match(g, gw, gh, tref, half, pcx, pcy, R, step) {
    const x0 = Math.max(half, pcx - R), x1 = Math.min(gw - half - 1, pcx + R);
    const y0 = Math.max(half, pcy - R), y1 = Math.min(gh - half - 1, pcy + R);
    let best = Infinity, bx = pcx, by = pcy;
    for (let cy = y0; cy <= y1; cy += step) {
      for (let cx = x0; cx <= x1; cx += step) {
        let sad = 0, k = 0, bail = false;
        for (let y = -half; y <= half && !bail; y++) {
          const row = (cy + y) * gw + cx;
          for (let x = -half; x <= half; x++) { const dpx = g[row + x] - tref[k++]; sad += dpx < 0 ? -dpx : dpx; }
          if (sad >= best) bail = true;
        }
        if (sad < best) { best = sad; bx = cx; by = cy; }
      }
    }
    const P = 2 * half + 1;
    return { x: bx, y: by, mean: best / (P * P) };   // mean abs pixel diff (0..255) = match quality
  }
  function _patchTrack(perFrame, gw, gh, { sx, sy, atSec, patchFrac = TRACK.patchFrac, searchFrac = TRACK.searchFrac, step = TRACK.step, adapt = TRACK.adapt, lostThresh = TRACK.lostThresh, recenter = TRACK.recenter }) {
    if (!perFrame.length) return [];
    let aIdx = 0, ab = Infinity;
    for (let i = 0; i < perFrame.length; i++) { const d = Math.abs(perFrame[i].t - atSec); if (d < ab) { ab = d; aIdx = i; } }
    const half = Math.max(4, Math.round(patchFrac * gw) >> 1);
    const tw = (2 * half + 1) / gw;
    const R = Math.max(4, Math.round(searchFrac * gw));
    const a = _extract(perFrame[aIdx].gray, gw, gh, Math.round(sx * gw), Math.round(sy * gh), half);
    const out = [{ t: perFrame[aIdx].t, cx: a.cx / gw, cy: a.cy / gh, w: tw }];
    // On a poor match (camera change / occlusion) → mark lost: emit a recenter point and
    // DON'T move the anchor, so it can re-acquire if the subject returns to the same spot.
    // Velocity prediction: search around prev + recent velocity so fast pans stay locked
    // (the face can travel further than R between samples if it keeps moving one way).
    const walk = (from, to, dir) => {
      let pcx = a.cx, pcy = a.cy, vx = 0, vy = 0, tref = (dir < 0) ? a.t.slice() : a.t;
      for (let i = from; dir > 0 ? i < to : i >= to; i += dir) {
        const px = Math.round(pcx + vx), py = Math.round(pcy + vy);
        const m = _match(perFrame[i].gray, gw, gh, tref, half, px, py, R, step);
        const pt = { t: perFrame[i].t, cx: m.x / gw, cy: m.y / gh, w: tw };
        if (m.mean > lostThresh) {
          if (recenter) { pt.cx = 0.5; pt.cy = 0.5; pt.lost = true; } else { pt.cx = pcx / gw; pt.cy = pcy / gh; pt.lost = true; }
          vx = 0; vy = 0;   // drop momentum on loss; keep pcx/pcy/tref to re-acquire near last good spot
        } else {
          vx = (m.x - pcx) * 0.7; vy = (m.y - pcy) * 0.7;   // damped momentum carried to next search
          pcx = m.x; pcy = m.y;
          if (adapt > 0) { const c = _extract(perFrame[i].gray, gw, gh, pcx, pcy, half).t; for (let k = 0; k < tref.length; k++) tref[k] = tref[k] * (1 - adapt) + c[k] * adapt; }
        }
        dir > 0 ? out.push(pt) : out.unshift(pt);
      }
    };
    walk(aIdx + 1, perFrame.length, 1);
    walk(aIdx - 1, 0, -1);
    out.sort((x, y) => x.t - y.t);
    return out;
  }
  // Refine a continuous backbone track by SNAPPING to a face detection when one sits
  // within snapR of the backbone position — precise face centering, no hopping (the
  // backbone, not the detector, decides WHO we follow). Index-aligned with perFrame.
  function _snapToFaces(backbone, perFrame, snapR) {
    const out = [];
    for (let i = 0; i < backbone.length; i++) {
      const p = backbone[i], dets = perFrame[i]?.dets || [];
      if (p.lost) { out.push(p); continue; }     // lost → stay recentred, don't snap to a stray face
      let best = null, bd = snapR;
      for (const dt of dets) { const d = Math.hypot(dt.cx - p.cx, dt.cy - p.cy); if (d < bd) { bd = d; best = dt; } }
      out.push(best ? { t: p.t, cx: best.cx, cy: best.cy, w: best.w } : p);
    }
    return out;
  }
  // Dispatcher. The PATCH tracker is always the backbone (skin-tone agnostic, never
  // hops). FACE mode = patch backbone + snap to nearby face detections for precision;
  // chosen when a face sits within seedRadius of the click. PATCH mode = backbone only.
  // forceMode 'faceonly' uses the old detection-linking path (for comparison).
  function _buildTrack(perFrame, gw, gh, opts) {
    const { sx = 0.5, sy = 0.5, atSec, seedRadius = TRACK.seedRadius, snapR = TRACK.snapR, forceMode = null,
            patchFrac = TRACK.patchFrac, searchFrac = TRACK.searchFrac, step = TRACK.step, adapt = TRACK.adapt,
            lostThresh = TRACK.lostThresh, recenter = TRACK.recenter,
            gate = TRACK.gate, maxGate = TRACK.maxGate, slack = TRACK.slack, seedWin = TRACK.seedWin, sizeW = TRACK.sizeW } = opts;
    let aIdx = 0, ab = Infinity;
    for (let i = 0; i < perFrame.length; i++) { const d = Math.abs(perFrame[i].t - atSec); if (d < ab) { ab = d; aIdx = i; } }
    // Find the detection nearest the click (near the anchor time) within seedRadius.
    let faceNear = false, faceSeed = null, fbd = seedRadius * seedRadius;
    for (let i = Math.max(0, aIdx - 2); i <= Math.min(perFrame.length - 1, aIdx + 2); i++) {
      for (const dt of perFrame[i].dets) {
        const d = (dt.cx - sx) ** 2 + (dt.cy - sy) ** 2;
        if (d <= seedRadius * seedRadius) { faceNear = true; if (d < fbd) { fbd = d; faceSeed = { cx: dt.cx, cy: dt.cy }; } }
      }
    }
    const mode = forceMode || (faceNear ? 'face' : 'patch');
    if (mode === 'faceonly') return { track: _linkTrack(perFrame, { sx, sy, atSec, gate, maxGate, slack, seedWin, sizeW }), mode };
    // In face mode, seed the patch backbone on the FACE centre (distinctive, robust) —
    // not the raw click, which may land on neck/body/background and fail to match.
    const ps = (mode === 'face' && faceSeed) ? faceSeed : { cx: sx, cy: sy };
    const backbone = _patchTrack(perFrame, gw, gh, { sx: ps.cx, sy: ps.cy, atSec, patchFrac, searchFrac, step, adapt, lostThresh, recenter });
    const track = mode === 'face' ? _snapToFaces(backbone, perFrame, snapR) : backbone;
    return { track, mode };
  }
  async function analyzeFaceTrack(opts = {}) {
    const { sx = 0.5, sy = 0.5, atSec = null, fps = TRACK.fps, gate = TRACK.gate,
            maxGate = TRACK.maxGate, slack = TRACK.slack, seedWin = TRACK.seedWin, sizeW = TRACK.sizeW,
            conf = TRACK.conf, longSide = TRACK.longSide, enhance = TRACK.enhance,
            seedRadius = TRACK.seedRadius, snapR = TRACK.snapR, patchFrac = TRACK.patchFrac,
            searchFrac = TRACK.searchFrac, step = TRACK.step, adapt = TRACK.adapt,
            lostThresh = TRACK.lostThresh, recenter = TRACK.recenter, autoOffRatio = TRACK.autoOffRatio, onProgress } = opts;
    const media = state.media;
    if (!media?.samples?.length) throw new Error('engine not active (no demuxed media)');
    const { samples, keyIdx, config } = media;
    const det = await ensureFaceDetector(conf);
    const win = window.canvasAPI?.getSourceWindow?.();
    const t0 = win ? win.start : samples[0].ts / 1e6;
    const t1 = win ? win.end   : samples[samples.length - 1].ts / 1e6;
    const period = 1 / Math.max(1, fps);
    const fw = config.codedWidth, fh = config.codedHeight;
    const scl = longSide / Math.max(fw, fh);
    const cw = Math.max(1, Math.round(fw * scl)), ch = Math.max(1, Math.round(fh * scl));
    const cnv = document.createElement('canvas'); cnv.width = cw; cnv.height = ch;
    const c2d = cnv.getContext('2d');
    if (enhance) c2d.filter = enhance;
    const gScl = 256 / Math.max(fw, fh);
    const gw = Math.max(1, Math.round(fw * gScl)), gh = Math.max(1, Math.round(fh * gScl));
    const gcnv = document.createElement('canvas'); gcnv.width = gw; gcnv.height = gh;
    const g2d = gcnv.getContext('2d', { willReadFrequently: true });
    const perFrame = [];
    let nextT = t0;
    const dec = new VideoDecoder({
      output: (f) => {
        const ts = f.timestamp / 1e6;
        if (ts < nextT - 1e-3 || ts > t1 + 0.25) { f.close(); return; }
        nextT = Math.max(nextT + period, ts + period * 0.5);
        c2d.drawImage(f, 0, 0, cw, ch);
        g2d.drawImage(f, 0, 0, gw, gh);
        f.close();
        _mpClock += 50;   // detectForVideo needs strictly-increasing timestamps ACROSS runs (detector persists)
        let res = null; try { res = det.detectForVideo(cnv, _mpClock); } catch (_) {}
        const dets = (res?.detections || []).map(d => {
          const b = d.boundingBox;
          return { cx: (b.originX + b.width / 2) / cw, cy: (b.originY + b.height / 2) / ch, w: b.width / cw, h: b.height / ch };
        });
        const gd = g2d.getImageData(0, 0, gw, gh).data;
        const gray = new Uint8Array(gw * gh);
        for (let p = 0, q = 0; p < gray.length; p++, q += 4) gray[p] = (gd[q] * 0.299 + gd[q + 1] * 0.587 + gd[q + 2] * 0.114) | 0;
        perFrame.push({ t: ts, dets, gray });
        if (onProgress) { try { onProgress(Math.min(1, (ts - t0) / Math.max(0.001, t1 - t0))); } catch (_) {} }
      },
      error: (e) => console.warn('[wc] tracker decode', e),
    });
    dec.configure(config);
    let startKf = keyIdx[0];
    for (const i of keyIdx) { if (samples[i].ts / 1e6 <= t0) startKf = i; else break; }
    for (let i = startKf; i < samples.length; i++) {
      const s = samples[i];
      if (s.ts / 1e6 > t1 + 0.3) break;
      if (dec.decodeQueueSize > 16) await new Promise(r => setTimeout(r, 0));
      dec.decode(new EncodedVideoChunk({ type: s.type, timestamp: s.ts, duration: s.dur, data: s.data }));
    }
    await dec.flush();
    try { dec.close(); } catch (_) {}
    _lastScan = { perFrame, gw, gh, t0, t1 };
    const { track, mode } = _buildTrack(perFrame, gw, gh, { sx, sy, atSec: atSec ?? t0, gate, maxGate, slack, seedWin, sizeW, seedRadius, snapR, patchFrac, searchFrac, step, adapt, lostThresh, recenter });
    const lostCount = track.reduce((n, p) => n + (p.lost ? 1 : 0), 0);
    const lostRatio = track.length ? lostCount / track.length : 1;
    const autoOff = lostRatio >= autoOffRatio;   // subject not trackable across the sequence → leave OFF for a clean re-seed
    if (track.length && window.wcReframe) {
      window.wcReframe.seed = { sx, sy, atSec: atSec ?? t0 };
      window.wcReframe.mode = mode;
      window.wcReframe.setTrack(track);
      window.wcReframe.enable(!autoOff);
    }
    const detd = perFrame.filter(p => p.dets.length).length;
    log(`tracker[${mode}]: ${perFrame.length} frames, ${detd} with a face, track ${track.length} pts, lost ${(lostRatio * 100) | 0}%${autoOff ? ' → no subject, OFF' : ''} (${t0.toFixed(1)}–${t1.toFixed(1)}s)`);
    return { frames: perFrame.length, detected: detd, points: track.length, mode, lostRatio, enabled: !autoOff, t0, t1 };
  }
  function _flashSeed(clientX, clientY) {
    const d = document.createElement('div');
    Object.assign(d.style, {
      position: 'fixed', left: `${clientX}px`, top: `${clientY}px`, width: '18px', height: '18px',
      margin: '-9px 0 0 -9px', borderRadius: '50%', border: '2px solid #ff3b3b',
      boxShadow: '0 0 0 2px rgba(0,0,0,.5), 0 0 10px rgba(255,59,59,.8)',
      pointerEvents: 'none', zIndex: '2147483647', transition: 'opacity .4s, transform .4s',
    });
    document.body.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = 'scale(1.6)'; });
    setTimeout(() => { d.style.opacity = '0'; }, 2200);
    setTimeout(() => { d.remove(); }, 2700);
  }
  let _trkDot = null, _trkRaf = 0;
  function trackMarker(on = true) {
    const cv = state.cv, host = cv?.parentElement;
    if (!on || !host) {
      if (_trkDot) { _trkDot.remove(); _trkDot = null; }
      cancelAnimationFrame(_trkRaf); _trkRaf = 0;
      if (window.wcReframe) window.wcReframe._suspend = false;   // resume the pan
      return;
    }
    if (window.wcReframe) window.wcReframe._suspend = true;       // suspend pan while inspecting (doesn't touch .enabled)
    if (!_trkDot) {
      _trkDot = document.createElement('div');
      Object.assign(_trkDot.style, {
        position: 'absolute', width: '16px', height: '16px', margin: '-8px 0 0 -8px',
        borderRadius: '50%', border: '2px solid #22e06b', boxShadow: '0 0 8px rgba(34,224,107,.9)',
        pointerEvents: 'none', zIndex: '2147483647', left: '-99px', top: '-99px',
      });
      host.appendChild(_trkDot);
    }
    const loop = () => {
      let t = 0; try { t = state.engine.currentSourceTime(); } catch (_) {}
      const p = window.wcReframe?.sample?.(t);
      if (p && cv) {
        _trkDot.style.left = `${cv.offsetLeft + p.cx * cv.offsetWidth}px`;
        _trkDot.style.top  = `${cv.offsetTop  + p.cy * cv.offsetHeight}px`;
        _trkDot.style.display = '';
      } else { _trkDot.style.display = 'none'; }
      _trkRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  let _boxWrap = null, _boxRaf = 0;
  function trackBoxes(on = true) {
    const cv = state.cv, host = cv?.parentElement;
    if (!on || !host || !_lastScan) {
      if (_boxWrap) { _boxWrap.remove(); _boxWrap = null; }
      cancelAnimationFrame(_boxRaf); _boxRaf = 0;
      if (window.wcReframe) window.wcReframe._suspend = false;
      if (!_lastScan && on) console.warn('[wc] tracker: run analyze() first');
      return;
    }
    if (window.wcReframe) window.wcReframe._suspend = true;
    if (!_boxWrap) {
      _boxWrap = document.createElement('div');
      Object.assign(_boxWrap.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '2147483646' });
      host.appendChild(_boxWrap);
    }
    const pf = _lastScan.perFrame;
    const nearest = (t) => {
      let lo = 0, hi = pf.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (pf[m].t < t) lo = m + 1; else hi = m; }
      return pf[lo];
    };
    const loop = () => {
      let t = 0; try { t = state.engine.currentSourceTime(); } catch (_) {}
      const fr = nearest(t);
      _boxWrap.innerHTML = '';
      if (fr) for (const d of fr.dets) {
        const b = document.createElement('div');
        Object.assign(b.style, {
          position: 'absolute',
          left:   `${cv.offsetLeft + (d.cx - d.w / 2) * cv.offsetWidth}px`,
          top:    `${cv.offsetTop  + (d.cy - d.h / 2) * cv.offsetHeight}px`,
          width:  `${d.w * cv.offsetWidth}px`,
          height: `${d.h * cv.offsetHeight}px`,
          border: '2px solid #ffd400', boxShadow: '0 0 0 1px rgba(0,0,0,.5)',
        });
        _boxWrap.appendChild(b);
      }
      _boxRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  let _seedCancel = null;   // cancels a pending seedByClick (UI "cancel arming")
  function cancelSeed() { if (_seedCancel) { const c = _seedCancel; _seedCancel = null; c(); } }
  function seedByClick(opts = {}) {
    return new Promise((resolve) => {
      const cv = state.cv;
      if (!cv) { console.warn('[wc] tracker: no engine canvas — enable preview first'); resolve(null); return; }
      // Visible frame = nearest ancestor that actually clips overflow (source_embed can
      // collapse to 0px since its children are absolutely positioned, so don't use it).
      let vis = cv.parentElement;
      while (vis && getComputedStyle(vis).overflow === 'visible' && vis.parentElement) vis = vis.parentElement;
      const onDown = (e) => {
        const r = cv.getBoundingClientRect();           // full canvas box → maps click to source coords (0..1)
        let v = vis ? vis.getBoundingClientRect() : r;
        if (!(v.width > 0 && v.height > 0)) v = r;       // degenerate → fall back to canvas rect
        const inside = e.clientX >= v.left && e.clientX <= v.right && e.clientY >= v.top && e.clientY <= v.bottom;
        if (!inside) return;
        e.preventDefault(); e.stopPropagation();
        window.removeEventListener('pointerdown', onDown, true);
        _seedCancel = null;
        _flashSeed(e.clientX, e.clientY);
        const sx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const sy = Math.min(1, Math.max(0, (e.clientY - r.top)  / r.height));
        let atSec = null; try { atSec = state.engine.currentSourceTime(); } catch (_) {}
        log(`tracker seed @ (${sx.toFixed(3)}, ${sy.toFixed(3)}) t=${atSec != null ? atSec.toFixed(2) : '?'}s — analyzing…`);
        if (opts.onArmed) { try { opts.onArmed(); } catch (_) {} }   // canvas clicked → analysis starting
        analyzeFaceTrack({ sx, sy, atSec, ...opts }).then(resolve).catch(err => { console.warn('[wc] tracker', err); resolve(null); });
      };
      window.addEventListener('pointerdown', onDown, true);
      _seedCancel = () => { window.removeEventListener('pointerdown', onDown, true); resolve(null); };
      log('tracker: click the subject in the preview to seed…');
    });
  }
  window.wcTracker = { analyze: analyzeFaceTrack, relink: relinkTrack, seedByClick, cancelSeed, marker: trackMarker, boxes: trackBoxes, ensureDetector: ensureFaceDetector };
  let _debug = false;
  let _ready = false;
  function _signalReady() {
    if (_ready) return;
    _ready = true;
    try { window.dispatchEvent(new CustomEvent('wcReady')); } catch (_) {}
  }
  function setBadge(show) {
    const parent = state.cv?.parentElement;
    let b = parent?.querySelector('.wc_debug_badge');
    if (show && parent) {
      if (!b) {
        b = document.createElement('div');
        b.className = 'wc_debug_badge';
        Object.assign(b.style, {
          position: 'absolute', top: '8px', left: '8px', zIndex: '99999',
          font: '700 11px system-ui, sans-serif', color: '#001b0e', background: '#3ef08a',
          padding: '3px 8px', borderRadius: '6px', pointerEvents: 'none',
          letterSpacing: '.5px', boxShadow: '0 1px 4px rgba(0,0,0,.4)',
        });
        b.textContent = '● WEBCODECS';
        parent.appendChild(b);
      }
    } else if (b) {
      b.remove();
    }
  }
  function getGpVideo() {
    return (window.canvasAPI?.getVideoElement?.())
        || document.querySelector('[wized="stream_clip_video"]');
  }
  async function enable() {
    if (state.active) return true;
    if (!SUPPORTED) { log('VideoDecoder not supported — staying on standby path'); return false; }
    const gpVideo = getGpVideo();
    const url = gpVideo && (gpVideo.currentSrc || gpVideo.src);
    if (!url) { log('no source on gpVideo yet'); return false; }
    const win = window.canvasAPI?.getSourceWindow?.() || null;
    if (!win && /vod\.itclips\.live/i.test(url)) {
      log('VOD source with no source window set — refusing whole-file fetch (open it as a vod clip first)');
      return false;
    }
    let media;
    try { media = await demux(url, win); }
    catch (e) { console.warn('[wc] demux failed, staying on standby path:', e); return false; }
    const cv = ensureCanvas(gpVideo, media.config);
    const engine = createEngine(gpVideo, cv, media);
    const api = window.canvasAPI;
    const startOt = (api?.sourceTimeToOutputTime?.(gpVideo.currentTime)) ?? 0;
    const wasPlaying = !gpVideo.paused && audioCtx().state === 'running';
    state.prevOpacity = gpVideo.style.opacity;
    state.prevMuted   = gpVideo.muted;
    gpVideo.pause();
    gpVideo.muted = true;
    gpVideo.style.opacity = '0';
    cv.style.display = 'block';
    engine.start(startOt, wasPlaying);
    window.wcEngine = {
      isActive: () => state.active,
      play: engine.play, pause: engine.pause, seekOutput: engine.seekOutput,
      get paused() { return engine.paused; },
      hasAudio: engine.hasAudio,
      outputDuration: engine.outputDuration,
      currentOutputTime: engine.currentOutputTime,
      currentSourceTime: engine.currentSourceTime,
      currentClipId: engine.currentClipId,
      currentFrameCanvas: engine.currentFrameCanvas,
      setVolume: engine.setVolume,
      audioContext: engine.audioContext,
      tapAudio: engine.tapAudio,
      untapAudio: engine.untapAudio,
      on: engine.on,
    };
    try {
      const bg = cv.parentElement?.parentElement?.querySelector('.bg_video');
      if (bg && !_IS_IOS && typeof cv.captureStream === 'function') {
        state.bg = bg;
        bg.srcObject = cv.captureStream();
        bg.play().catch(() => {});
      }
    } catch (_) {}
    Object.assign(state, { active: true, engine, cv, gpVideo, media, url });
    if (_debug) setBadge(true);
    window._timelineStartPlayhead?.();
    window._wcFacecamLoops?.forEach(fn => { try { fn(); } catch (_) {} });
    const syncBtns = () => {
      const on = !engine.paused;
      document.querySelectorAll('#play_button, #timeline_play_button')
        .forEach(b => b && b.classList.toggle('is-playing', on));
    };
    engine.on('play', syncBtns); engine.on('pause', syncBtns);
    engine.on('play', () => window._timelineStartPlayhead?.());
    syncBtns();
    buildThumbsFor(url, media);
    _signalReady();
    log(`preview ENABLED — audio-clock master${engine.hasAudio ? '' : ' (no audio track; video-only clock)'}`);
    return true;
  }
  function disable() {
    if (!state.active) return;
    setBadge(false);
    const eng = state.engine, gp = state.gpVideo;
    const srcTime = eng?.currentSourceTime?.() ?? null;
    const wasPlaying = eng ? !eng.paused : false;
    eng?.stop();
    if (state.cv) state.cv.style.display = 'none';
    if (gp) {
      gp.style.opacity = state.prevOpacity || '';
      gp.muted = state.prevMuted;
      if (srcTime != null && isFinite(srcTime)) { try { gp.currentTime = srcTime; } catch (_) {} }
      if (wasPlaying) gp.play().catch(() => {});
    }
    if (state.bg) {
      try { state.bg.srcObject = (gp && typeof gp.captureStream === 'function') ? gp.captureStream() : null; state.bg.play().catch(() => {}); } catch (_) {}
      state.bg = null;
    }
    document.querySelectorAll('#play_button, #timeline_play_button')
      .forEach(b => b && b.classList.toggle('is-playing', wasPlaying));
    window.wcEngine = null;
    Object.assign(state, { active: false, engine: null });
    log('preview DISABLED (back on standby path)');
  }
  function debug(on = true) { _debug = !!on; if (state.active) setBadge(_debug); return _debug; }
  function status() {
    return {
      flag: FLAG(), supported: SUPPORTED, active: state.active, ready: _ready,
      source: getGpVideo()?.currentSrc || null,
    };
  }
  window.wcPreview = {
    enable, disable, status, debug, demux,
    isReady: () => _ready,
    onReady: (cb) => { if (_ready) cb(); else window.addEventListener('wcReady', () => cb(), { once: true }); },
  };
  function boot() {
    if (!SUPPORTED) { log('module loaded — VideoDecoder unsupported, inert'); _signalReady(); return; }
    if (!FLAG())    { log('module loaded — flag off, inert. Toggle: window.wcPreview.enable()'); _signalReady(); return; }
    let tries = 0;
    const tryEnable = async () => {
      if (state.active) return;
      const gp  = getGpVideo();
      const url = gp && (gp.currentSrc || gp.src);
      if (url) {
        const isVod    = /vod\.itclips\.live/i.test(url);
        const winReady = !isVod || !!window.canvasAPI?.getSourceWindow?.();
        if (winReady && await enable()) return;
      }
      if (++tries < 150) setTimeout(tryEnable, 200);
      else _signalReady();
    };
    tryEnable();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();