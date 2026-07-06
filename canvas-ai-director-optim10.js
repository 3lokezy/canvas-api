(function () {
  'use strict';

  // Version beacon — bump on every deploy-worthy change so "is the fix actually live?" is answered by the
  // console, not by guesswork. Check: window.__aiDirectorVersion.
  const VERSION = 'v2.7-storyboard';
  window.__aiDirectorVersion = VERSION;
  console.log('[ai-polish] director', VERSION);
  // Pipeline stage trace — one loud line per stage so a broken flow shows exactly where it stopped:
  // ①scan ②digest-stashed ③request-out ④response-in ⑤validate/compile ⑥applied
  const stage = (n, msg, ...d) => console.log('%c[ai-polish] ' + n + ' ' + msg, 'color:#7c4dff;font-weight:bold', ...d);
  const kb = x => { try { return Math.round(JSON.stringify(x).length / 1024) + 'KB'; } catch (_) { return '?KB'; } };

  // ── AUTONOMOUS AI EDITOR ("AI Polish") ────────────────────────────────────────
  // Premium LLM editor that OWNS the whole edit. Sends a digest (content + on-screen scan + constraints)
  // to an n8n webhook (model-agnostic, schema-validated EDIT PLAN — see AI_DIRECTOR_SPEC.md), then rebuilds
  // the clip from a CLEAN base: an ordered `segments` array (each = a kept source range + its layout) → one
  // setClips, overriding everything. Full-state snapshot → one-click revert. v1 = trim / cut / reorder /
  // per-segment mode+zoom + title. v2 = sound / music / fx (the parked garnish, same contract).
  const CFG = (window.aiDirectorCfg = Object.assign({
    url:      '',     // ← n8n webhook: window.aiDirectorCfg.url = 'https://…'
    GAP:      0.6,    // s — sentence-split gap for the digest transcript
    ZOOM_MIN: 1.0, ZOOM_MAX: 2.2,
    // ── beats grammar (deterministic auto-edit, lab port) ──
    SOLO_EVERY: 3,       // every Nth beat of a two-person turn is a solo punch; the rest keep both faces
    BEAT_SPLIT_MIN: 4.2, // s — turns longer than this get chopped into ~3s word-snapped beats
    OVERLAP_MAX: 0.12,   // top-view ∩ bottom-crop may share at most this fraction of the bottom crop
    LB_MAX: 1.8, LB_SPAN_FULL: 0.72,   // letterbox crop-in cap; faces spanning > this of the width = full band
    LB_FIT: 0.32,        // ≈ fit-width zoom for 16:9-in-9:16 — applyGpZoom clamps to the exact floor anyway
    DEAD: 0.018,         // follow-crop dead-band — jitter below this never moves the crop
    OVERLAY_ZOOM_MAX: 1.4,  // overlay/split: main frame stays modest + centred (cam is a separate corner)
    TWO_SHOT_ZOOM_MAX: 1.1, // is-full with 2+ central faces: frame both, don't punch in past one
    EDGE_NEAR: 0.24,        // face's distance-to-nearest-border < this = a corner cam (matches classify)
    SCAN_FPS:  5,           // scene-scan sample rate — also the resolution of scan-derived tracks (was 3);
                            // client-side + decode-bound, so the cost is a few extra background seconds
    SCAN_RES:  768,         // detection input long-side px (was the 512 default) — catches smaller/distant faces
    SB_CELLS:  20,          // storyboard contact sheet — max cells (4 rows × 5 cols); ≤20 keeps cells legible
    THUMB_SIDE: 320,        // scan thumb long-side px — storyboard cells need more than the old 224
    MOVE_THRESH: 0.08,      // face path spread (norm) over a segment above this = "moving" (worth tracking)
    FIT_MARGIN: 1.35,       // multi-face fit: padding factor around the faces' bounding box
    FIT_MAX_SPAN: 0.30,     // a portrait crop shows ~32% of source width; faces wider apart than this can't BOTH fit → feature one
    TRACK_PUNCH: 1.25,      // default zoom for a tracked (follow) segment if the model didn't ask for more
    BOTTOM_ZOOM_MIN: 0.7, BOTTOM_ZOOM_MAX: 1.8,   // split bottom-panel framing (1=head-and-shoulders, >1 tighter)
    MIN_SEG:  1.2,    // s — drop sub-second fragments (a 0.6s island reads as a glitch, not an edit)
    MAX_SEGS: 40,
    // Non-verbal awareness (gap signals + multimodal frames):
    GAP_MIN: 0.7,        // s — a silence between transcript lines this long gets measured + annotated
    GAP_MAX: 24,         // cap on annotated gaps per digest (longest clips)
    FRAMES_MAX: 9,       // max keyframe snapshots attached to the model (gaps → reactions → audio peaks)
    AUDIO_LOUD: 0.8,     // gap peak ≥ this × the clip's median SPEECH loudness = something loud is happening
    AUDIO_QUIET: 0.35,   // below this × speech median = genuinely quiet
    // Conversation structure (people/turns — the smart-editor layer):
    PERSON_R: 0.13,      // normalized distance — detections within this of a cluster = the same seated person
    PERSON_MIN: 0.15,    // a cluster present in ≥ this fraction of scan frames = a real participant
  }, window.aiDirectorCfg));

  const api   = () => window.canvasAPI;
  const wzText = (k) => document.querySelector(`[wized="${k}"]`)?.textContent.trim() || '';
  const num    = (v, d) => Number.isFinite(+v) ? +v : d;
  let _planFacecam = null;   // authoritative facecam (box+pos) the n8n response carries from the Supabase row
  let _lastGaps = null;      // the gap annotations sent with the last digest — validate() audits cuts against them

  // Map an OUTPUT-time second → SOURCE time (overlay windows like the title gate by source time). Good for a
  // title that shows from the start for N seconds (within the first segment); across cuts it's approximate.
  function srcAtOutput(a, ot) {
    const clips = a.getOutputClips?.() || [];
    for (const c of clips) if (ot >= c.outputStart && ot < c.outputEnd) return c.sourceStart + (ot - c.outputStart);
    const last = clips[clips.length - 1];
    return last ? last.sourceEnd : ot;
  }

  // ── Feature registry (v2 modules) ──────────────────────────────────────────────
  // Each entry applies its OWN section of the plan to the existing subsystem. Adding a feature = add one entry
  // here + its schema fragment + prompt module in AI_DIRECTOR_SPEC.md (+ any n8n resolver). Music is first;
  // sfx / titles / subtitles / images slot in the same way. Errors are isolated per-feature.
  const FEATURES = {
    // Background music bed: model picks a track_id from music_library; n8n resolves it to a url. One bed, low under speech.
    music(plan, a) {
      const m = plan.music;
      if (!m || !m.url) return;
      a.setMusic(m.url);
      a.setMusicVolume?.(Number.isFinite(+m.volume) ? Math.max(0, Math.min(1, +m.volume)) : 0.2);
      if (Number.isFinite(+m.offset) && +m.offset > 0) a.setMusicOffset?.(+m.offset);
      a.setMusicMuted?.(false);
      console.log('[ai-polish] music', m.name || m.url, '· vol', m.volume);
    },
    // Soundboard one-shots: model emits sfx[] of {sound_id, at}; n8n resolves to {url, name, overlay}. Replace the lane.
    sfx(plan, a) {
      if (!Array.isArray(plan.sfx) || !a.setSoundboardSounds) return;
      const cues = plan.sfx
        .filter(c => c && c.url)
        .map(c => ({ url: c.url, at: Math.max(0, +c.at || 0), name: c.name || '', overlay: c.overlay || null }));
      a.setSoundboardSounds(cues);
      console.log('[ai-polish] sfx', cues.length, 'cues');
    },
    // Title look + position + TIMING (text set in applyPlan via setTitle). style = style-NNN id or "" = default.
    // title_in/title_out are OUTPUT seconds (the final cut); mapped to the source-time window the gate uses.
    titles(plan, a) {
      if ('title_style' in plan) a.setTitleStyle?.(plan.title_style || null);
      if (plan.title_zone) a.setTitleZone?.(plan.title_zone);
      if (Number.isFinite(+plan.title_out) && +plan.title_out > 0) {
        const inOt  = Math.max(0, +plan.title_in || 0);
        const outOt = Math.max(inOt + 0.3, +plan.title_out);
        a.setTitleTiming?.(srcAtOutput(a, inOt), srcAtOutput(a, outOt));
        console.log('[ai-polish] title timing', inOt + '→' + outOt + 's (output)');
      }
      if (plan.title_style || plan.title_zone) console.log('[ai-polish] title', plan.title_style || 'default', plan.title_zone || '');
    },
    // Subtitle look + position (text is automatic from the transcript). style = a style-NNN id or "" = default.
    subtitles(plan, a) {
      if ('subtitle_style' in plan) a.setSubtitleStyle?.(plan.subtitle_style || null);
      if (plan.subtitle_zone) a.setSubtitleZone?.(plan.subtitle_zone);
      if (plan.subtitle_style || plan.subtitle_zone) console.log('[ai-polish] subtitle', plan.subtitle_style || 'default', plan.subtitle_zone || '');
    },
    // Contextual image / meme pop-ups → the MULTI-image track. Model emits images[] (each a short pop-up with a
    // query + source: 'meme'=Klipy gif/meme, 'web'=SerpApi still). n8n resolves each query→url; the client just
    // places them. Output-time anchored (at=from, dur=to−from) — no source-time conversion (unlike the legacy
    // single-image path). Empty/absent ⇒ leave existing images (a run that adds none doesn't wipe manual ones).
    // GIF urls animate automatically via wcGif; non-CORS urls silently don't draw (never a broken/tainted frame).
    image(plan, a) {
      if (!Array.isArray(plan.images) || !a.setImages) return;
      const cues = plan.images
        .filter(im => im && im.url)
        .map(im => {
          const from = Math.max(0, +im.from || 0);
          const to   = Math.max(from + 0.3, +im.to || (from + 3));
          return {
            url:   im.url,
            at:    from,
            dur:   Math.max(0.3, Math.min(8, to - from)),                       // safety-cap the window
            x:     Number.isFinite(+im.x) ? +im.x : 0.5,                        // central by default
            y:     Number.isFinite(+im.y) ? +im.y : 0.5,
            scale: Number.isFinite(+im.scale) ? Math.max(0.1, Math.min(3, +im.scale)) : 0.35,
            name:  im.query || '',
          };
        });
      a.setImages(cues);
      console.log('[ai-polish] images', cues.length);
    },
  };
  function applyFeatures(plan, a) {
    for (const k in FEATURES) { try { FEATURES[k](plan, a); } catch (e) { console.warn('[ai-polish] feature ' + k, e); } }
  }

  // ── digest signal readers ──────────────────────────────────────────────────────
  function readTranscript() {
    let arr;
    try { arr = JSON.parse(document.querySelector('[wized="stream_clip_transcript"]')?.textContent.trim() || ''); }
    catch (_) { return []; }
    if (!Array.isArray(arr) || !arr.length) return [];
    const v = document.querySelector('[wized="stream_clip_video"]');
    if (/\/clips\//i.test(v?.currentSrc || v?.src || '')) {           // segment clip → rebase words to 0-based
      const off = parseFloat(wzText('stream_clip_source_start') || '0') * 1000;
      if (off > 0 && arr[0].start >= off) arr = arr.map(w => ({ ...w, start: Math.max(0, w.start - off), end: Math.max(0, w.end - off) }));
    }
    return arr;
  }
  function sentences(words) {
    const out = []; let cur = null;
    const flush = () => {   // t = start, end = end — clean cut boundaries; speaker = the line's majority diarized voice
      const line = { t: cur.t, end: +cur.to.toFixed(1), text: cur.text };
      const spk = Object.keys(cur.spk).sort((a, b) => cur.spk[b] - cur.spk[a])[0];
      if (spk) line.speaker = spk;
      out.push(line);
    };
    const addSpk = (w, dur) => { if (w.speaker) cur.spk[w.speaker] = (cur.spk[w.speaker] || 0) + dur; };
    for (const w of words) {
      const s = w.start / 1000, e = w.end / 1000;
      if (!cur) { cur = { t: +s.toFixed(1), to: e, text: w.text, spk: {} }; addSpk(w, e - s); continue; }
      // a SPEAKER CHANGE is also a sentence boundary — turns are the conversation editor's cut points
      const turn = w.speaker && Object.keys(cur.spk).length && !cur.spk[w.speaker];
      if (/[.!?]$/.test(cur.text) || (s - cur.to) > CFG.GAP || turn) {
        flush(); cur = { t: +s.toFixed(1), to: e, text: w.text, spk: {} }; addSpk(w, e - s);
      } else { cur.to = e; cur.text += ' ' + w.text; addSpk(w, e - s); }
    }
    if (cur) flush();
    return out;
  }

  // ── SCENE GRAPH (v2 perception — server-built once per clip) ────────────────────
  // The Debian sidecar analyses each clip at ingest: embedding-verified person identities, per-⅓s face boxes
  // + mouth-motion, diarization-bound speakers, typed shots. The clip row carries the JSON (bound into the DOM
  // like the transcript). Everything below prefers the graph and degrades to the browser scan for clips that
  // predate it. Graph times are CLIP-LOCAL (the analysed mp4 is 0-based) — helpers take ABSOLUTE source times
  // and rebase via the source window, so all existing call sites stay unchanged.
  let _sg = null, _sgKey = null;
  function sceneGraph() {
    const key = wzText('stream_clip_id') || 'nokey';
    if (_sgKey === key) return _sg;
    _sgKey = key; _sg = null;
    try {
      let raw = window.__sceneGraph || document.querySelector('[wized="stream_clip_scene_graph"]')?.textContent.trim();
      for (let i = 0; i < 3 && typeof raw === 'string' && raw; i++) raw = JSON.parse(raw);   // tolerate double-encoded rows
      if (raw && Array.isArray(raw.timeline) && Array.isArray(raw.persons)) {
        _sg = raw;
        console.log('[ai-polish] scene graph loaded:', raw.persons.length, 'persons,',
          (raw.shots || []).length, 'shots,', Object.keys(raw.speakers || {}).length, 'speakers bound');
      }
    } catch (_) { _sg = null; }
    return _sg;
  }
  const sgOff = () => api()?.getSourceWindow?.()?.start || 0;
  // Timeline rows within an ABSOLUTE source range.
  function sgRows(absFrom, absTo) {
    const g = sceneGraph(); if (!g) return [];
    const o = sgOff();
    return g.timeline.filter(r => r.t >= absFrom - o - 0.17 && r.t <= absTo - o + 0.17);
  }
  // A person's measured position + size within an ABSOLUTE range — per-moment accurate (no clip averages).
  function sgPosIn(pid, absFrom, absTo) {
    let sx = 0, sy = 0, sw = 0, n = 0;
    for (const r of sgRows(absFrom, absTo)) {
      for (const f of r.faces) {
        if (f.p !== pid) continue;
        sx += (f.b[0] + f.b[2]) / 2; sy += (f.b[1] + f.b[3]) / 2; sw += (f.b[2] - f.b[0]); n++;
      }
    }
    return n >= 2 ? { cx: sx / n, cy: sy / n, size: sw / n, n } : null;
  }
  // Graph shots → the digest's scan shape (typed spans + primary-face info) — replaces the browser
  // classification when the graph exists. Sidecar shot type CAM_OVERLAY maps to the client's OVERLAY_CAM.
  function graphScanDigest() {
    const g = sceneGraph(); if (!g || !Array.isArray(g.shots) || !g.shots.length) return null;
    const byId = {}; for (const p of (g.persons || [])) byId[p.id] = p;
    return g.shots.map(s => {
      const ppl = (s.people || []).map(id => byId[id]).filter(Boolean)
        .sort((a, b) => (b.size * b.presence) - (a.size * a.presence));
      const prim = ppl[0];
      return {
        from: s.from, to: s.to,
        type: s.type === 'CAM_OVERLAY' ? 'OVERLAY_CAM' : s.type,
        face: prim ? { cx: prim.cx, cy: prim.cy, edge: prim.edge, size: prim.size, count: ppl.length } : null,
        faces: ppl.length > 1 ? ppl.map(p => ({ cx: p.cx, cy: p.cy, edge: p.edge, size: p.size })) : undefined,
      };
    });
  }

  // Raw classified scene segments from the cached scan (sync; classify does NOT re-decode). [] if no scan yet.
  function sceneSegs() {
    try { return window.aiScenes?.classify?.(window._scan) || []; } catch (_) { return []; }
  }
  // How much the dominant face moves across the scan's raw frames within [from,to] (scan source-time): the
  // spread of its path. Tells the AI when a subject is MOVING (worth a follow-track) vs static (steady frame).
  function segMotion(from, to, primary) {
    const pf = window._scan?.perFrame; if (!pf || !primary) return null;
    let prev = { cx: primary.cx, cy: primary.cy }, minX = 1, maxX = 0, minY = 1, maxY = 0, n = 0;
    for (const fr of pf) {
      if (fr.t < from || fr.t > to || !fr.dets.length) continue;
      let best = null, bd = Infinity;                                  // follow the nearest detection frame-to-frame
      for (const d of fr.dets) { const c = (d.cx - prev.cx) ** 2 + (d.cy - prev.cy) ** 2; if (c < bd) { bd = c; best = d; } }
      if (!best) continue;
      prev = best; n++;
      minX = Math.min(minX, best.cx); maxX = Math.max(maxX, best.cx);
      minY = Math.min(minY, best.cy); maxY = Math.max(maxY, best.cy);
    }
    if (n < 2) return null;
    return Math.hypot(maxX - minX, maxY - minY) > CFG.MOVE_THRESH ? 'moving' : 'static';
  }
  // Map a classified segment → digest shape: dominant face with EDGE (distance to nearest border — low = a
  // corner cam, the facecam signal) + SIZE, the full prominent-face list when 2+ are on screen (frame-both /
  // split / fit-all), and a MOTION tag (moving = follow-track candidate). `off` rebases the scan's ABSOLUTE
  // source times to clip-relative so the model sees ONE time base (transcript + scan + gaps all clip-local —
  // matters on VOD windows where off>0; the internal segMotion query stays absolute).
  function digestSeg(s, off) {
    const faces = (s.faces || []).map(f => ({ cx: +f.cx.toFixed(2), cy: +f.cy.toFixed(2), edge: +f.edge.toFixed(2), size: +(f.size || 0).toFixed(2) }));
    return {
      from: +(s.from - off).toFixed(1), to: +(s.to - off).toFixed(1), type: s.type,
      face: s.primary ? { cx: +s.primary.cx.toFixed(2), cy: +s.primary.cy.toFixed(2), edge: +s.primary.edge.toFixed(2), size: +(s.primary.size || 0).toFixed(2), count: faces.length || 1 } : null,
      faces: faces.length > 1 ? faces : undefined,
      motion: s.primary ? segMotion(s.from, s.to, s.primary) || undefined : undefined,
    };
  }
  // scene scan + per-segment face/edge/motion data — "what's on screen" for mode/zoom/split/track decisions.
  // Requests THUMBS (per-frame JPEGs for the multimodal gap frames); a cached scan without them is re-run once.
  async function scan() {
    if (!window.aiScenes?.classify) return [];
    if ((!window._scan || !window._scan.thumbs) && window.wcTracker?.scan) {
      try { window._scan = await window.wcTracker.scan({ fps: CFG.SCAN_FPS, longSide: CFG.SCAN_RES, thumbs: true, thumbSide: CFG.THUMB_SIDE }); } catch (_) {}
    }
    const off = api()?.getSourceWindow?.()?.start || 0;
    return sceneSegs().map(s => digestSeg(s, off));
  }

  // ── Non-verbal awareness: measure the SILENCES ─────────────────────────────────
  // The transcript is the model's only rich signal — it's blind to laughter, action, reactions and graphics,
  // so it treats every silence as dead air. These functions measure each inter-speech gap (audio energy from
  // the engine's decoded buffer, pixel motion + face activity from the scan) and attach keyframe snapshots of
  // the ambiguous ones, so the model can HEAR and SEE what the words don't say. Everything degrades to "no
  // gaps section" on any failure — the edit itself is never blocked.
  let _audioProf = null;   // cached RMS profile for the current audioBuffer
  function audioProfile() {
    const buf = window.wcEngine?.audioBuffer?.();
    if (!buf) return null;
    if (_audioProf && _audioProf.src === buf) return _audioProf;
    try {
      const ch = buf.getChannelData(0);
      const bucket = 0.1;                                          // 100ms energy buckets
      const per = Math.max(1, Math.round(buf.sampleRate * bucket));
      const n = Math.max(1, Math.ceil(ch.length / per));
      const rms = new Float32Array(n);
      for (let b = 0; b < n; b++) {
        let s = 0; const s0 = b * per, s1 = Math.min(ch.length, s0 + per);
        for (let i = s0; i < s1; i += 4) s += ch[i] * ch[i];        // stride-4 sampling — fine for an energy estimate
        rms[b] = Math.sqrt(s / Math.max(1, (s1 - s0) / 4));
      }
      _audioProf = { src: buf, rms, bucket, base: window.wcEngine?.audioBaseSec?.() || 0 };
    } catch (_) { _audioProf = null; }
    return _audioProf;
  }
  function energyIn(prof, absFrom, absTo) {                        // {mean,peak} RMS over an ABSOLUTE source range
    const b0 = Math.max(0, Math.floor((absFrom - prof.base) / prof.bucket));
    const b1 = Math.min(prof.rms.length - 1, Math.ceil((absTo - prof.base) / prof.bucket));
    let peak = 0, sum = 0, n = 0;
    for (let b = b0; b <= b1; b++) { const v = prof.rms[b]; sum += v; n++; if (v > peak) peak = v; }
    return n ? { mean: sum / n, peak } : { mean: 0, peak: 0 };
  }
  function speechBaseline(prof, tr, off) {                         // median speech loudness = the clip's own reference level
    const vals = tr.map(l => energyIn(prof, off + l.t, off + l.end).mean).filter(v => v > 0).sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }
  function gapScan(absFrom, absTo) {                               // pixel motion + face activity across a gap's scan frames
    const pf = window._scan?.perFrame; if (!pf) return { motion: null, face: null };
    let mSum = 0, mN = 0, faceN = 0, n = 0, minX = 1, maxX = 0, minY = 1, maxY = 0, prev = null;
    for (const fr of pf) {
      if (fr.t < absFrom || fr.t > absTo) continue;
      n++;
      if (typeof fr.motion === 'number') { mSum += fr.motion; mN++; }
      if (fr.dets.length) {
        faceN++;
        let best = fr.dets[0];
        if (prev) { let bd = Infinity; for (const d of fr.dets) { const c = (d.cx - prev.cx) ** 2 + (d.cy - prev.cy) ** 2; if (c < bd) { bd = c; best = d; } } }
        prev = best;
        minX = Math.min(minX, best.cx); maxX = Math.max(maxX, best.cx);
        minY = Math.min(minY, best.cy); maxY = Math.max(maxY, best.cy);
      }
    }
    let face = null;
    if (n) face = !faceN ? 'none' : ((faceN >= 2 && Math.hypot(maxX - minX, maxY - minY) > CFG.MOVE_THRESH) ? 'reacting' : 'present');
    return { motion: mN ? mSum / mN : null, face };
  }
  // Annotate every silence ≥ GAP_MIN with measured audio/motion/face + a verdict. (Keyframe attachment moved
  // to pickFrames — one shared budget across gaps, listener reactions and audio peaks.)
  function buildGaps(tr, dur, off) {
    try {
      if (!Array.isArray(tr) || !tr.length || !(dur > 0)) return [];
      const spans = [];
      if (tr[0].t >= CFG.GAP_MIN) spans.push({ from: 0, to: tr[0].t });
      for (let i = 0; i < tr.length - 1; i++) {
        const a = tr[i].end, b = tr[i + 1].t;
        if (b - a >= CFG.GAP_MIN) spans.push({ from: a, to: b });
      }
      const lastEnd = tr[tr.length - 1].end;
      if (dur - lastEnd >= CFG.GAP_MIN) spans.push({ from: lastEnd, to: dur });
      if (!spans.length) return [];

      const prof = audioProfile();
      const base = prof ? speechBaseline(prof, tr, off) : 0;
      const pf = window._scan?.perFrame || [];
      const mVals = pf.map(f => f.motion).filter(v => typeof v === 'number').sort((a, b) => a - b);
      const mMed = mVals.length ? mVals[Math.floor(mVals.length / 2)] : 0;

      return spans.slice(0, CFG.GAP_MAX).map(sp => {
        const g = { from: +sp.from.toFixed(1), to: +sp.to.toFixed(1), dur: +(sp.to - sp.from).toFixed(1) };
        if (prof && base > 0) {
          const r = energyIn(prof, off + sp.from, off + sp.to).peak / base;
          g.audio = r >= CFG.AUDIO_LOUD ? 'loud' : (r >= CFG.AUDIO_QUIET ? 'mid' : 'quiet');
        }
        const sc = gapScan(off + sp.from, off + sp.to);
        if (sc.motion != null) g.motion = sc.motion > Math.max(mMed * 1.8, 0.015) ? 'high' : (sc.motion < Math.max(mMed * 0.6, 0.006) ? 'low' : 'mid');
        if (sc.face) g.face = sc.face;
        const hot  = g.audio === 'loud' || g.motion === 'high' || g.face === 'reacting';
        const dead = (g.audio === 'quiet' || !g.audio) && (g.motion === 'low' || !g.motion) && g.face !== 'reacting';
        g.verdict = hot ? 'keep_hint' : (dead ? 'likely_dead' : 'unclear');
        return g;
      });
    } catch (e) { console.warn('[ai-polish] gap signals failed (degrading to none)', e); return []; }
  }

  // ── Conversation structure: PEOPLE + TURNS (the smart-editor layer) ─────────────
  // Cluster the scan's face detections by position continuity into stable person identities (A/B/C…,
  // lettered left→right). Seated conversations cluster cleanly; a walking subject fragments and simply
  // doesn't qualify (presence gate) — everything degrades to today's behaviour when no people emerge.
  let _people = null, _peopleScan = null;
  function buildPeople() {
    // GRAPH-FIRST: embedding-verified identities with diarization-bound speakers — no clustering guesswork.
    const g = sceneGraph();
    if (g) {
      return (g.persons || []).filter(p => p.presence >= CFG.PERSON_MIN).slice(0, 6).map(p => ({
        id: p.id, cx: p.cx, cy: p.cy, size: p.size, edge: p.edge, presence: p.presence,
        speaker: p.speaker || undefined,
        pos: p.cx < 0.4 ? 'left' : (p.cx > 0.6 ? 'right' : 'centre'),
      }));
    }
    const scan = window._scan, pf = scan?.perFrame;
    if (!pf || !pf.length) return [];
    if (_people && _peopleScan === scan) return _people;
    const clusters = [];
    for (const fr of pf) {
      for (const d of fr.dets) {
        let best = null, bd = Infinity;
        for (const c of clusters) { const dist = Math.hypot(d.cx - c.cx, d.cy - c.cy); if (dist < bd) { bd = dist; best = c; } }
        if (best && bd < CFG.PERSON_R) {
          best.n++;
          best.cx += (d.cx - best.cx) / best.n; best.cy += (d.cy - best.cy) / best.n;
          best.size += ((d.w + d.h) / 2 - best.size) / best.n;
        } else clusters.push({ cx: d.cx, cy: d.cy, size: (d.w + d.h) / 2, n: 1 });
      }
    }
    const total = pf.length;
    const keep = clusters.filter(c => c.n / total >= CFG.PERSON_MIN && c.n >= 3)
      .sort((a, b) => b.n - a.n).slice(0, 4)
      .sort((a, b) => a.cx - b.cx);                                   // letter left→right
    const letters = ['A', 'B', 'C', 'D'];
    _peopleScan = scan;
    _people = keep.map((c, i) => ({
      id: letters[i],
      cx: +c.cx.toFixed(2), cy: +c.cy.toFixed(2), size: +c.size.toFixed(2),
      edge: +Math.min(c.cx, 1 - c.cx, c.cy, 1 - c.cy).toFixed(2),
      presence: +(c.n / total).toFixed(2),
      pos: c.cx < 0.4 ? 'left' : (c.cx > 0.6 ? 'right' : 'centre'),
    }));
    return _people;
  }
  function personById(id) { return buildPeople().find(p => p.id === id) || null; }
  // Nearest registered person for a detection (same radius the clustering used).
  function assignPerson(d, people) {
    let best = null, bd = Infinity;
    for (const p of people) { const dist = Math.hypot(d.cx - p.cx, d.cy - p.cy); if (dist < bd) { bd = dist; best = p; } }
    return best && bd < CFG.PERSON_R ? best.id : null;
  }
  // A person's measured position within an ABSOLUTE source range (mean of their detections) — the accurate
  // per-segment anchor for framing/tracking a `person` shot. Falls back to the registry seat.
  function personPosIn(id, absFrom, absTo) {
    if (sceneGraph()) {
      const pos = sgPosIn(id, absFrom, absTo);       // per-moment graph boxes; null = not on screen there
      if (pos) return pos;
      return null;                                    // graph is authoritative — don't fall back to averages
    }
    const people = buildPeople(); if (!people.length) return null;
    const pf = window._scan?.perFrame || [];
    let sx = 0, sy = 0, n = 0;
    for (const fr of pf) {
      if (fr.t < absFrom || fr.t > absTo) continue;
      for (const d of fr.dets) if (assignPerson(d, people) === id) { sx += d.cx; sy += d.cy; n++; }
    }
    if (n >= 2) return { cx: sx / n, cy: sy / n };
    const p = personById(id);
    return p ? { cx: p.cx, cy: p.cy } : null;
  }
  // Head-and-shoulders crop box for a person — the DUO split's bottom panel (mirrors the corner-cam camBox
  // idea, padded wider + shifted down so shoulders read in a half-height portrait panel).
  function personBox(p) {
    const w = Math.min(0.9, Math.max(0.18, p.size * 2.6));
    const h = Math.min(0.9, Math.max(0.22, p.size * 3.2));
    const cx = p.cx, cy = Math.min(1 - h / 2, p.cy + p.size * 0.35);
    return {
      x1: +Math.max(0, cx - w / 2).toFixed(3), y1: +Math.max(0, cy - h / 2).toFixed(3),
      x2: +Math.min(1, cx + w / 2).toFixed(3), y2: +Math.min(1, cy + h / 2).toFixed(3),
    };
  }
  // Enrich transcript lines with the conversation view: who's VISIBLE during the line (`faces`), whose face
  // region is most ACTIVE (`hint` ≈ the speaker — talking is head/mouth movement), and a visible NON-speaker
  // that's clearly moving (`reacting` — the silent-reaction-worth-cutting-to signal). 2+ people only.
  function enrichTurns(tr, off, people) {
    try {
      if (!Array.isArray(tr) || !tr.length || !people || people.length < 2) return tr;
      // GRAPH-FIRST: `hint` = the diarization-bound person of the line's audio speaker (CERTAIN, not a
      // motion guess); `faces` = who the graph sees during the line; `reacting` = a visible non-speaker
      // with real mouth/face activity. Same output fields — the prompt doesn't change.
      const g = sceneGraph();
      if (g) {
        return tr.map(l => {
          const rows = sgRows(off + l.t, off + l.end);
          const mm = {};
          for (const r of rows) for (const f of r.faces) { const a = (mm[f.p] ||= { n: 0, s: 0 }); a.n++; a.s += f.mm; }
          const ids = Object.keys(mm);
          if (!ids.length) return l;
          const out = { ...l, faces: [...ids].sort() };
          const hint = (l.speaker && g.speakers && g.speakers[l.speaker]) || null;
          if (hint && ids.includes(hint)) out.hint = hint;
          const others = ids.filter(id => id !== out.hint && mm[id].n >= 2)
                            .sort((x, y) => (mm[y].s / mm[y].n) - (mm[x].s / mm[x].n));
          if (others.length && (mm[others[0]].s / mm[others[0]].n) > 0.08) out.reacting = others[0];
          return out;
        });
      }
      const pf = window._scan?.perFrame || [];
      return tr.map(l => {
        const acc = {};
        for (const fr of pf) {
          if (fr.t < off + l.t || fr.t > off + l.end) continue;
          for (const d of fr.dets) {
            const id = assignPerson(d, people); if (!id) continue;
            const a = (acc[id] ||= { n: 0, act: 0 });
            a.n++; a.act += (typeof d.act === 'number' ? d.act : 0);
          }
        }
        const ids = Object.keys(acc);
        if (!ids.length) return l;
        for (const id of ids) acc[id].act = acc[id].act / acc[id].n;
        const rank = [...ids].sort((a, b) => acc[b].act - acc[a].act);
        const out = { ...l, faces: [...ids].sort() };
        const top = rank[0], second = rank[1];
        if (top && acc[top].act > 0.003 && (!second || acc[top].act >= acc[second].act * 1.25)) out.hint = top;
        if (out.hint) {
          const re = rank.find(id => id !== out.hint && acc[id].act >= Math.max(0.004, acc[out.hint].act * 0.45));
          if (re) out.reacting = re;
        }
        return out;
      });
    } catch (_) { return tr; }
  }
  // ONE shared frame budget (FRAMES_MAX) across everything worth SHOWING the model: ambiguous/hot gaps,
  // listener reactions, audio peaks. Stamps `frame: N` refs onto the gap/line it samples; returns the b64
  // list (→ Gemini inline parts) + a legend (frame № → time + why) that rides in the text prompt.
  function pickFrames(gaps, lines, peaks, off) {
    const frames = [], legend = [];
    try {
      if (!window._scan?.thumbs) return { frames, legend };
      const pf = window._scan.perFrame || [];
      const used = [];
      const grab = (clipT, why) => {
        if (frames.length >= CFG.FRAMES_MAX || !isFinite(clipT)) return null;
        if (used.some(u => Math.abs(u - clipT) < 1.2)) return null;
        const abs = off + clipT;
        let best = null, bd = Infinity;
        for (const fr of pf) { if (!fr.thumb) continue; const d = Math.abs(fr.t - abs); if (d < bd) { bd = d; best = fr; } }
        if (!best || bd > 1.5) return null;
        used.push(clipT);
        const n = frames.length + 1;
        frames.push({ frame: n, t: +(best.t - off).toFixed(1), b64: best.thumb.split(',')[1] || '' });
        legend.push({ frame: n, t: +clipT.toFixed(1), why });
        return n;
      };
      for (const g of gaps.filter(g => g.verdict === 'unclear').concat(gaps.filter(g => g.verdict === 'keep_hint')).sort((a, b) => b.dur - a.dur)) {
        const n = grab((g.from + g.to) / 2, 'silent gap'); if (n) g.frame = n;
      }
      for (const l of lines) {
        if (!l.reacting) continue;
        const n = grab((l.t + l.end) / 2, 'listener reaction (' + l.reacting + ')'); if (n) l.frame = n;
      }
      for (const p of (peaks || [])) grab(p, 'audio peak');
    } catch (_) {}
    return { frames, legend };
  }
  // STORYBOARD contact sheet — the model's EYES over the WHOLE clip in one image: a labeled grid of
  // uniformly sampled cells, timestamp + cell id burned into each, hotspot borders (orange = ambiguous/
  // keep_hint gap, red = audio peak) so measured signals sit ON the pixels they describe. Cell ids are the
  // model's spatial vocabulary: it cites C7, we map C7 → time → graph rows — it never emits coordinates.
  async function buildStoryboard(gaps, peaks, off, dur) {
    try {
      const pf = ((window._scan && window._scan.perFrame) || []).filter(f => f.thumb);
      if (pf.length < 4 || !(dur > 0)) return null;
      const N = Math.max(8, Math.min(CFG.SB_CELLS, Math.round(dur / 2.5)));
      const COLS = 5, CW = 320, CH = 180, GUT = 10, LBL = 30;
      const rows = Math.ceil(N / COLS);
      const cnv = document.createElement('canvas');
      cnv.width  = COLS * CW + (COLS + 1) * GUT;
      cnv.height = rows * (CH + LBL) + (rows + 1) * GUT;
      const ctx = cnv.getContext('2d');
      ctx.fillStyle = '#161616'; ctx.fillRect(0, 0, cnv.width, cnv.height);
      const picks = Array.from({ length: N }, (_, i) => {
        const t = off + (i + 0.5) * dur / N;
        let best = null, bd = Infinity;
        for (const fr of pf) { const d = Math.abs(fr.t - t); if (d < bd) { bd = d; best = fr; } }
        return best;
      });
      const imgs = await Promise.all(picks.map(p => new Promise(res => {
        if (!p) return res(null);
        const im = new Image();
        im.onload = () => res({ im, t: p.t }); im.onerror = () => res(null);
        im.src = p.thumb;
      })));
      const cells = [];
      for (let i = 0; i < N; i++) {
        const got = imgs[i]; if (!got) continue;
        const col = i % COLS, row = (i / COLS) | 0;
        const x = GUT + col * (CW + GUT), y = GUT + row * (CH + LBL + GUT);
        const iw = got.im.width, ih = got.im.height, s = Math.max(CW / iw, CH / ih);
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, CW, CH); ctx.clip();
        ctx.drawImage(got.im, x + (CW - iw * s) / 2, y + (CH - ih * s) / 2, iw * s, ih * s);
        ctx.restore();
        const tc = +(got.t - off).toFixed(1);
        const hotGap  = gaps.find(g => (g.verdict === 'keep_hint' || g.verdict === 'unclear') && tc >= g.from - 0.3 && tc <= g.to + 0.3);
        const hotPeak = (peaks || []).some(p => Math.abs(p - tc) < 0.8);
        if (hotGap || hotPeak) {
          ctx.strokeStyle = hotPeak ? '#e33' : '#f90'; ctx.lineWidth = 5;
          ctx.strokeRect(x + 2.5, y + 2.5, CW - 5, CH - 5);
        }
        ctx.fillStyle = '#000'; ctx.fillRect(x, y + CH, CW, LBL);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 20px system-ui, Arial'; ctx.textBaseline = 'middle';
        ctx.fillText('C' + (i + 1) + '  ·  ' + tc.toFixed(1) + 's', x + 8, y + CH + LBL / 2);
        const cell = { cell: 'C' + (i + 1), t: tc };
        if (hotGap) cell.gap = hotGap.verdict;
        if (hotPeak) cell.peak = true;
        cells.push(cell);
      }
      if (!cells.length) return null;
      const b64 = cnv.toDataURL('image/jpeg', 0.62).split(',')[1] || '';
      console.log('[ai-polish] storyboard: ' + cells.length + ' cells, ' + Math.round(b64.length * 0.75 / 1024) + 'KB');
      return { b64, cells, cols: COLS };
    } catch (e) { console.warn('[ai-polish] storyboard failed', e); return null; }
  }
  // The clip's loudest moments (clip-relative seconds, ≥1.5s apart) — beat candidates for sfx/pop-ups/punch-ins.
  function audioPeaks(off, dur, max = 5) {
    const prof = audioProfile(); if (!prof || !(dur > 0)) return [];
    try {
      const b0 = Math.max(0, Math.floor((off - prof.base) / prof.bucket));
      const b1 = Math.min(prof.rms.length - 1, Math.ceil((off + dur - prof.base) / prof.bucket));
      const idx = [];
      for (let b = b0; b <= b1; b++) idx.push(b);
      idx.sort((x, y) => prof.rms[y] - prof.rms[x]);
      const out = [];
      for (const b of idx) {
        const t = (b * prof.bucket) + prof.base - off;
        if (t < 0 || t > dur) continue;
        if (out.some(p => Math.abs(p - t) < 1.5)) continue;
        out.push(+t.toFixed(1));
        if (out.length >= max) break;
      }
      return out.sort((x, y) => x - y);
    } catch (_) { return []; }
  }
  // The classified scan segment that overlaps [from,to] most — for code-side framing guards.
  function faceWindow(from, to) {
    // GRAPH-FIRST: per-moment mean box per person WITHIN the window (from/to are absolute source seconds
    // here — callers pass off+...), not a scene-run average. is-full framing lands where faces ARE.
    const g = sceneGraph();
    if (g) {
      const agg = {};
      for (const r of sgRows(from, to)) {
        for (const f of r.faces) {
          const a = (agg[f.p] ||= { sx: 0, sy: 0, sw: 0, n: 0 });
          a.sx += (f.b[0] + f.b[2]) / 2; a.sy += (f.b[1] + f.b[3]) / 2; a.sw += (f.b[2] - f.b[0]); a.n++;
        }
      }
      const score = f => f.size * (f.edge >= CFG.EDGE_NEAR ? 1 : 0.5);   // central faces outrank corner cams
      const faces = Object.keys(agg).filter(id => agg[id].n >= 2).map(id => {
        const a = agg[id], cx = a.sx / a.n, cy = a.sy / a.n;
        return { id, cx, cy, size: a.sw / a.n, edge: Math.min(cx, 1 - cx, cy, 1 - cy) };
      }).sort((x, y) => score(y) - score(x));
      if (faces.length) return { primary: faces[0], faces };
      return null;
    }
    let best = null, bestOv = 0;
    for (const s of sceneSegs()) {
      if (!s.primary) continue;
      const ov = Math.min(to, s.to) - Math.max(from, s.from);
      if (ov > bestOv) { bestOv = ov; best = s; }
    }
    return best;
  }
  // A prominent EDGE face (corner cam) anywhere in the scan → split/overlay viable even if Supabase didn't
  // flag a facecam (the applier injects the crop region so split renders).
  function scanHasCam() {
    const g = sceneGraph();
    if (g) return (g.persons || []).some(p => p.presence >= 0.3 && p.edge < CFG.EDGE_NEAR);
    return sceneSegs().some(s => s.primary && s.primary.edge < CFG.EDGE_NEAR);
  }
  function content() {
    let keywords = []; try { keywords = JSON.parse(wzText('stream_clip_keywords') || '[]'); } catch (_) {}
    return {
      hook: wzText('stream_clip_hook'), summary: wzText('stream_clip_summary'),
      keywords, moment_type: wzText('stream_clip_moment_type'), tier: wzText('stream_clip_tier'),
      topic: wzText('stream_clip_source_title') || wzText('stream_clip_title'),
    };
  }
  // The full editable source extent (the LLM trims/cuts WITHIN [0, source_duration], clip-local).
  function sourceDuration() {
    const a = api(); const win = a?.getSourceWindow?.();
    if (win) return +(win.end - win.start).toFixed(1);
    const v = document.querySelector('[wized="stream_clip_video"]');
    return +((v && isFinite(v.duration) ? v.duration : a?.getTimelineDuration?.()) || 0).toFixed(1);
  }
  function constraints() {
    const cam = wzText('stream_clip_contains_facecam').toLowerCase() === 'true';
    const scanCam = scanHasCam();
    // DUO: 2+ stable CENTRAL people (a conversation) unlocks is-split as a two-up stack — featured person in
    // the main (top) frame, the other cropped into the bottom panel (injectCamIfNeeded builds the crop).
    const duo = buildPeople().filter(p => p.edge >= CFG.EDGE_NEAR).length >= 2;
    const hasCam = cam || scanCam || !!_planFacecam || duo;
    return { modes: hasCam ? ['is-full', 'is-split', 'is-overlay'] : ['is-full'], contains_facecam: cam, scan_cam: scanCam, duo };
  }
  // Enumerate the title/subtitle style presets straight from the editor's picker buttons — auto-syncs as you add
  // styles in Webflow. Each button's wized attr (e.g. "title_style_001") → "style-001"; its text = the label.
  function styleBank(groupId) {
    return Array.from(document.querySelectorAll('#' + groupId + ' .editor_config-option')).map(btn => {
      const m = (btn.getAttribute('wized') || '').match(/_(\d{3})$/);
      const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      return m ? { id: 'style-' + m[1], label } : null;   // default (no number) → null, skipped
    }).filter(Boolean);
  }
  async function buildDigest() {
    if (!api()) { console.warn('[ai-polish] buildDigest: canvasAPI not ready'); return null; }
    stage('①', 'client scan starting (fps ' + CFG.SCAN_FPS + ', res ' + CFG.SCAN_RES + ', thumbs ' + CFG.THUMB_SIDE + 'px)…');
    // The browser scan still runs for what the GRAPH doesn't carry: the multimodal gap FRAMES (jpeg thumbs)
    // + audio/motion gap signals. Everything identity/position/shot/speaker shaped prefers the graph.
    const scanSegs = await scan();                                  // also ensures window._scan (with thumbs) exists
    stage('①', 'scan done: ' + ((window._scan && window._scan.perFrame) || []).length + ' frames, graph ' +
          (sceneGraph() ? 'LOADED (' + (sceneGraph().persons || []).length + ' persons)' : 'MISSING — scan-only fallback'));
    const gScan    = graphScanDigest();                             // typed shots from the sidecar (authoritative)
    const dur      = sourceDuration();
    const off      = api()?.getSourceWindow?.()?.start || 0;
    const people   = buildPeople();                                 // stable person identities (A/B/C, left→right)
    const tr       = enrichTurns(sentences(readTranscript()), off, people);   // lines gain faces/hint/reacting
    const gaps     = buildGaps(tr, dur, off);                       // non-verbal awareness: measured silences
    const peaks    = audioPeaks(off, dur);                          // loudest clip moments — beat candidates
    const fr       = pickFrames(gaps, tr, peaks, off);              // ONE frame budget: gaps → reactions → peaks
    const sb       = await buildStoryboard(gaps, peaks, off, dur);  // contact sheet — rides FIRST in the image parts
    // The cam the CLIENT already knows (DOM-wired Supabase crop → injected → scan corner cam). Sent so n8n can
    // fall back to it when the POSTed row's coords don't parse — without it a real cam clip degrades to
    // facecam:null and the model plans a flat all-is-full edit (the whole FACECAM module keys on this object).
    const camB = baseCamBox();
    const camC = camB ? { cx: +((camB.x1 + camB.x2) / 2).toFixed(3), cy: +((camB.y1 + camB.y2) / 2).toFixed(3) } : null;
    // Scan honesty: FACECAM_BIAS labels no-detection windows OVERLAY_CAM (right — the cam IS there, MediaPipe
    // just can't lock a small corner cam), but the digest then said "OVERLAY_CAM, face:null" — a contradiction
    // the model can't act on. When we KNOW the cam box, backfill those rows' face from it.
    if (camB) {
      const camFace = { cx: camC.cx, cy: camC.cy, edge: +Math.min(camC.cx, 1 - camC.cx, camC.cy, 1 - camC.cy).toFixed(3), size: +(camB.x2 - camB.x1).toFixed(2), count: 1 };
      for (const s of scanSegs) if ((s.type === 'OVERLAY_CAM' || s.type === 'DUO_OVERLAY') && !s.face) s.face = camFace;
    }
    _lastGaps = gaps;
    stage('②', 'digest built: ' + tr.length + ' lines, ' + gaps.length + ' gaps (' +
          gaps.filter(g => g.verdict === 'keep_hint').length + ' keep_hint), ' + (peaks || []).length + ' peaks, ' +
          fr.frames.length + ' hotspot frames, storyboard ' + (sb ? sb.cells.length + ' cells' : 'NONE') +
          ', facecam ' + (camB ? 'YES' : 'no'));
    return {
      facecam:         camB ? { cx: camC.cx, cy: camC.cy, edge: +Math.min(camC.cx, 1 - camC.cx, camC.cy, 1 - camC.cy).toFixed(3), box: camB } : null,
      clip_id:         wzText('stream_clip_id') || null,
      source_duration: dur,
      content:         content(),
      people:          people,                                      // conversation participants (registry)
      speakers:        sceneGraph()?.speakers || undefined,         // audio speaker ↔ person binding (graph)
      transcript:      tr,                                          // enriched: faces / hint / reacting / frame refs
      scan:            gScan || scanSegs,
      gaps:            gaps,                                        // annotated silences: audio/motion/face/verdict
      audio_peaks:     peaks,
      frames:          fr.legend,                                   // legend: frame № → time + why it was sampled
      storyboard:      sb ? { cells: sb.cells, cols: sb.cols } : undefined,   // cell id → time map (+ gap/peak flags)
      // image parts, in attach order: the storyboard sheet FIRST (when built), then the hotspot frames.
      gap_frames:      (sb ? [{ frame: 0, t: -1, b64: sb.b64 }] : []).concat(fr.frames),
      constraints:     constraints(),
      title_styles:    styleBank('title_style_group'),
      subtitle_styles: styleBank('subtitle_style_group'),
    };
  }

  // ── validate + apply (segments → clips, overriding everything) ──────────────────
  // Face-aware framing for is-full (the code GUARANTEES centring, not the model): snap onto a single central
  // face, centre + widen for a two-shot, leave the model's focus for faceless/broll. Then clamp the focus so
  // the target stays inside the frame at the chosen zoom.
  function frameFull(absFrom, absTo, zoom, fx, fy) {
    const sc = faceWindow(absFrom, absTo);
    if (sc && sc.primary) {
      const central = (sc.faces || []).filter(f => f.edge >= CFG.EDGE_NEAR);
      if (central.length >= 2) {                       // multiple central faces
        let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
        for (const f of central) {
          const r = (f.size || 0.12) / 2;
          x1 = Math.min(x1, f.cx - r); x2 = Math.max(x2, f.cx + r);
          y1 = Math.min(y1, f.cy - r); y2 = Math.max(y2, f.cy + r);
        }
        if (x2 - x1 <= CFG.FIT_MAX_SPAN) {             // close enough → frame the whole group
          fx = (x1 + x2) / 2; fy = (y1 + y2) / 2;
          const ext = Math.max(x2 - x1, y2 - y1) * CFG.FIT_MARGIN;   // visible frame at zoom Z spans 1/Z
          zoom = Math.max(1, Math.min(zoom, ext > 0.001 ? 1 / ext : zoom));
        } else {                                        // too far apart for portrait → FEATURE one (AI picks who via focusX)
          let pick = central[0], bd = Infinity;
          for (const f of central) { const d = Math.abs(f.cx - fx); if (d < bd) { bd = d; pick = f; } }
          fx = pick.cx; fy = pick.cy;
        }
      } else if (sc.primary.edge >= CFG.EDGE_NEAR) {   // single central face → snap onto it
        fx = sc.primary.cx; fy = sc.primary.cy;
      }
      // an edge/corner primary in full mode is a cam shown fullscreen — keep the model's central focus, don't snap to the corner
    }
    const m = 0.5 / zoom;                              // keep the focus target inside the frame at this zoom
    return { zoom, focusX: Math.max(m, Math.min(1 - m, fx)), focusY: Math.max(m, Math.min(1 - m, fy)) };
  }
  // Scan-derived follow track for an absolute source range: seed on the segment's dominant face, link across
  // the scan's perFrame (NO new decode pass), clip to the range so it doesn't wander into a neighbour scene.
  // Returns override.tracking.raw ([{t,cx,cy,w}]) or null.
  function buildTrack(absFrom, absTo, seedPos) {
    // GRAPH-FIRST: the graph's per-⅓s boxes for one identity ARE the track — no linking heuristics, and it
    // can never jump to a different person mid-segment (identity is embedding-verified server-side).
    const g = sceneGraph();
    if (g) {
      const o = sgOff(), rows = sgRows(absFrom, absTo);
      let pid = null;
      if (seedPos) {                                   // follow the person nearest the seed
        let bd = Infinity;
        for (const p of buildPeople()) { const d = Math.hypot(p.cx - seedPos.cx, p.cy - seedPos.cy); if (d < bd) { bd = d; pid = p.id; } }
      }
      if (!pid) {                                      // else the most-present person in the range
        const c = {};
        for (const r of rows) for (const f of r.faces) c[f.p] = (c[f.p] || 0) + 1;
        pid = Object.keys(c).sort((x, y) => c[y] - c[x])[0];
      }
      if (pid) {
        const raw = [];
        for (const r of rows) for (const f of r.faces) if (f.p === pid) {
          raw.push({ t: +(r.t + o).toFixed(2), cx: +((f.b[0] + f.b[2]) / 2).toFixed(3),
                     cy: +((f.b[1] + f.b[3]) / 2).toFixed(3), w: +(f.b[2] - f.b[0]).toFixed(3) });
        }
        if (raw.length >= 2) return raw;
      }
      return null;                                     // graph had nobody trackable here — don't guess from the scan
    }
    const pf = window._scan?.perFrame;
    const seed = seedPos || faceWindow(absFrom, absTo)?.primary;   // a `person` shot seeds on THAT person
    if (!pf || !seed || !window.wcTracker?.linkFromScan) return null;
    const raw = window.wcTracker.linkFromScan(pf, { sx: seed.cx, sy: seed.cy, atSec: (absFrom + absTo) / 2 });
    return raw.filter(p => p.t >= absFrom - 0.3 && p.t <= absTo + 0.3);
  }
  function validate(plan) {
    const srcDur  = sourceDuration() || Infinity;
    const allowed = new Set(constraints().modes);
    const off     = api()?.getSourceWindow?.()?.start || 0;   // scan/face data is in absolute source time
    const segments = (Array.isArray(plan?.segments) ? plan.segments : []).map(s => {
      const from = Math.max(0, Math.min(srcDur, +s.from));
      const to   = Math.max(0, Math.min(srcDur, +s.to));
      if (to - from < CFG.MIN_SEG) return null;
      // LETTERBOX (lab port): full-width band + blurred fill. Expressed as is-full at fit-width zoom —
      // applyGpZoom clamps up to the fit-width floor and the blurred bg_video/backdrop already sits behind
      // in full mode (render parity via drawBackdropFrame). lzoom > 1 = crop into the band (side-trim).
      if (s.mode === 'is-letterbox' || s.mode === 'letterbox') {
        const lz = Math.max(1, Math.min(CFG.LB_MAX, num(s.lzoom, 1)));
        return { from, to, mode: 'is-full', letterbox: true,
                 zoom: +(CFG.LB_FIT * lz).toFixed(3),          // < 1 on purpose — floors at fit-width live
                 focusX: Math.max(0, Math.min(1, num(s.focusX, 0.5))), focusY: 0.5 };
      }
      const mode = allowed.has(s.mode) ? s.mode : 'is-full';
      // `person` — who this shot FEATURES (conversation grammar). Resolve to their measured position within
      // the segment so the framing is guaranteed, not guessed from the model's focusX.
      const pid = (typeof s.person === 'string' && s.person.trim()) ? s.person.trim().toUpperCase() : null;
      const pp  = pid ? personPosIn(pid, off + from, off + to) : null;
      if (mode === 'is-full') {
        // track:true → follow a moving subject (scan-derived track built at apply time); else static face-aware framing
        const track = !!s.track && !!window._scan?.perFrame;
        const z  = Math.max(CFG.ZOOM_MIN, Math.min(CFG.ZOOM_MAX, num(s.zoom, track || pp ? CFG.TRACK_PUNCH : 1)));
        const fr = frameFull(off + from, off + to, z, pp ? pp.cx : num(s.focusX, 0.5), pp ? pp.cy : num(s.focusY, 0.5));
        return { from, to, mode, zoom: fr.zoom, focusX: fr.focusX, focusY: fr.focusY, track, person: pp ? pid : undefined };
      }
      // Split/overlay. LEGACY (corner-cam reaction): the cam is a separate crop, so the main frame is forced
      // centred + modestly zoomed. DUO (person given, 2+ central people): the main (top) frame PUNCHES on the
      // featured person — the other participant rides the bottom crop (injectCamIfNeeded).
      // BOTTOM-PANEL COMPOSITION (per-clip override.facecam): `bottom_person` = the model's explicit pick for
      // who rides the bottom (default = the non-featured participant); `bottom_zoom` = its framing (1 =
      // head-and-shoulders, >1 tighter reaction punch, <1 wider) — clamped, applied in applyPlan.
      const bp = (typeof s.bottom_person === 'string' && s.bottom_person.trim()) ? s.bottom_person.trim().toUpperCase() : undefined;
      const bzRaw = +s.bottom_zoom;
      const bz = (Number.isFinite(bzRaw) && bzRaw > 0)
        ? +Math.max(CFG.BOTTOM_ZOOM_MIN, Math.min(CFG.BOTTOM_ZOOM_MAX, bzRaw)).toFixed(2) : undefined;
      if (pp && mode === 'is-split') {
        // A person-split's top MUST be a real punch on the featured person — floor at TRACK_PUNCH, never
        // wide. A wide top inevitably contains the bottom subject too (the same-face-twice screenshot).
        const z = Math.max(CFG.TRACK_PUNCH, Math.min(CFG.ZOOM_MAX, num(s.zoom, CFG.TRACK_PUNCH)));
        const m = 0.5 / z;
        return {
          from, to, mode, zoom: z,
          focusX: Math.max(m, Math.min(1 - m, pp.cx)),
          focusY: Math.max(m, Math.min(1 - m, pp.cy)),
          person: pid, bottomPerson: bp, bottomZoom: bz,
        };
      }
      return {
        from, to, mode,
        zoom:   Math.max(CFG.ZOOM_MIN, Math.min(CFG.OVERLAY_ZOOM_MAX, num(s.zoom, 1))),
        focusX: 0.5, focusY: 0.5,
        bottomPerson: bp, bottomZoom: bz,
      };
    }).filter(Boolean).slice(0, CFG.MAX_SEGS);
    // CUT AUDIT (advisory): flag any silence the signals marked as CONTENT (keep_hint) that the plan cut
    // anyway — surfaces over-cutting for tuning; the model was told to justify these in `analysis`.
    try {
      for (const g of (_lastGaps || [])) {
        if (g.verdict !== 'keep_hint') continue;
        const mid = (g.from + g.to) / 2;
        if (!segments.some(s => mid >= s.from && mid <= s.to)) console.warn('[ai-polish] AUDIT: keep_hint gap was cut', g);
      }
    } catch (_) {}
    const _inN = Array.isArray(plan?.segments) ? plan.segments.length : 0;
    if (_inN && segments.length < _inN)
      console.warn('[ai-polish] validate: dropped ' + (_inN - segments.length) + ' of ' + _inN +
                   ' segments (< MIN_SEG ' + CFG.MIN_SEG + 's, bad numbers, or disallowed mode)');
    return { segments, title: typeof plan?.title === 'string' ? plan.title.trim() : '' };
  }

  // Make split/overlay renderable: ensure a facecam crop exists (else applyMode coerces the mode → full).
  // Runs AFTER the snapshot so revert clears it. Priority: (1) the AUTHORITATIVE box from the clip row that the
  // n8n response carries — the dedicated locator's result, far better than the lightweight scan; (2) the
  // Supabase crop already wired via the DOM; (3) a scan-detected corner cam as a last resort.
  function injectCamIfNeeded(segments, facecam) {
    const a = api();
    if (!a?.setFacecamCrop) return;
    const needsCam = segments.some(s => s.mode === 'is-split' || s.mode === 'is-overlay');
    if (!needsCam) return;
    if (facecam && facecam.box) {                                        // (1) authoritative — from the Supabase row
      const b = facecam.box;
      a.setFacecamCrop({ x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2 });
      console.log('[ai-polish] facecam crop from clip row', b);
      return;
    }
    if (wzText('stream_clip_contains_facecam').toLowerCase() === 'true') return;   // (2) DOM-wired Supabase crop
    const cam = sceneSegs().filter(s => s.primary && s.primary.edge < CFG.EDGE_NEAR)   // (3) scan fallback
                           .sort((x, y) => (y.to - y.from) - (x.to - x.from))[0];
    if (cam && window.aiScenes?.camBox) { a.setFacecamCrop(window.aiScenes.camBox(cam.primary)); console.log('[ai-polish] injected facecam crop from scan', cam.primary); return; }
    // (4) DUO — no facecam anywhere but 2+ central people: inject a SEED base crop (least-featured central
    // person, clip-wide position). AI-applied split clips NEVER render this — applyPlan guarantees each one an
    // in-window override.facecam or downgrades it to is-full. The seed exists purely so a MANUAL split toggle
    // after the edit renders something adjustable (drag/wheel it into place) instead of coercing to full.
    const central = buildPeople().filter(p => p.edge >= CFG.EDGE_NEAR);
    if (central.length >= 2) {
      const counts = {};
      for (const s of segments) if (s.mode === 'is-split' && s.person) counts[s.person] = (counts[s.person] || 0) + 1;
      const featured = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0] || null;
      const bottom = central.filter(p => p.id !== featured).sort((x, y) => y.presence - x.presence)[0] || central[1];
      a.setFacecamCrop(personBox(bottom));
      console.log('[ai-polish] duo seed base crop (manual-split fallback only) =', bottom.id);
    }
  }

  // ── split bottom-panel composition (per-clip override.facecam) ────────────────
  // Rescale a crop box around its centre: f>1 tighter (punch-in), f<1 wider — the same cover-fit surface the
  // manual wheel-zoom composes, shifted back inside the frame. MINB mirrors the wheel's tightest crop.
  function scaleBox(b, f) {
    if (!b) return null;
    if (!Number.isFinite(f) || f === 1) return b;
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2, MINB = 0.06;
    const w = Math.max(MINB, Math.min(1, (b.x2 - b.x1) / f)), h = Math.max(MINB, Math.min(1, (b.y2 - b.y1) / f));
    let x1 = cx - w / 2, y1 = cy - h / 2, x2 = cx + w / 2, y2 = cy + h / 2;
    if (x1 < 0) { x2 -= x1; x1 = 0; }
    if (y1 < 0) { y2 -= y1; y1 = 0; }
    if (x2 > 1) { x1 -= (x2 - 1); x2 = 1; }
    if (y2 > 1) { y1 -= (y2 - 1); y2 = 1; }
    return { x1: +Math.max(0, x1).toFixed(4), y1: +Math.max(0, y1).toFixed(4), x2: +Math.min(1, x2).toFixed(4), y2: +Math.min(1, y2).toFixed(4) };
  }
  // Is the clip's cam a REAL static overlay (gaming corner webcam) — the only kind a fixed crop can ride?
  // IRL clips get boxes too (a person near the frame edge classifies as "corner"), but a static crop on
  // moving IRL footage shows walls/doors/scalps (the four-screenshot failure). The graph adjudicates.
  function isRealOverlayCam() {
    const g = sceneGraph();
    if (g && g.facecam) return !!g.facecam.found && (g.facecam.type === 'OVERLAY_CAM' || g.facecam.type === 'DUO_OVERLAY');
    return wzText('stream_clip_contains_facecam').toLowerCase() === 'true' || scanHasCam();
  }
  // The clip's base cam box — same priority order injectCamIfNeeded seeds the base from: the authoritative
  // n8n-carried row box → the DOM-wired Supabase crop → the scan's dominant corner cam.
  function baseCamBox() {
    if (_planFacecam?.box) { const b = _planFacecam.box; return { x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2 }; }
    if (wzText('stream_clip_contains_facecam').toLowerCase() === 'true') {
      const g = k => parseFloat(wzText('stream_clip_facecam_' + k));
      const b = { x1: g('x1'), y1: g('y1'), x2: g('x2'), y2: g('y2') };
      if ([b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) && b.x2 > b.x1 && b.y2 > b.y1) return b;
    }
    const sg = sceneGraph();                          // the sidecar's own locator pass (same box the row gets)
    if (sg?.facecam?.found && (sg.facecam.type === 'OVERLAY_CAM' || sg.facecam.type === 'DUO_OVERLAY')) {
      const b = sg.facecam;
      if ([b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) && b.x2 > b.x1 && b.y2 > b.y1)
        return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
    }
    const cam = sceneSegs().filter(s => s.primary && s.primary.edge < CFG.EDGE_NEAR)
                           .sort((x, y) => (y.to - y.from) - (x.to - x.from))[0];
    return (cam && window.aiScenes?.camBox) ? window.aiScenes.camBox(cam.primary) : null;
  }
  // Who is TALKING during [absFrom, absTo]? The most face-ACTIVE central person in the window (act = face-region
  // motion ≈ mouth/head movement — the same signal enrichTurns uses for the transcript `hint`). Lets a
  // personless split in a duo scene self-heal: infer the featured person instead of falling back to a static
  // clip-wide crop. null when <2 central people or nothing measurable in the window.
  function activePersonIn(absFrom, absTo) {
    // GRAPH-FIRST: who talks most in this window per the diarized words, resolved to a person via the
    // graph's speaker binding — ground truth, and they must actually be ON SCREEN in the window.
    const g = sceneGraph();
    if (g && g.speakers && Object.keys(g.speakers).length) {
      const o = sgOff(), talk = {};
      for (const w of readTranscript()) {
        const s = w.start / 1000, e = w.end / 1000;
        if (e < absFrom - o || s > absTo - o || !w.speaker) continue;
        const pid = g.speakers[w.speaker];
        if (pid) talk[pid] = (talk[pid] || 0) + (e - s);
      }
      const best = Object.keys(talk).sort((x, y) => talk[y] - talk[x])[0];
      if (best && sgPosIn(best, absFrom, absTo)) return best;
    }
    const pf = window._scan?.perFrame || [];
    const people = buildPeople().filter(p => p.edge >= CFG.EDGE_NEAR);
    if (people.length < 2) return null;
    const acc = {};
    for (const fr of pf) {
      if (fr.t < absFrom || fr.t > absTo) continue;
      for (const d of fr.dets) {
        const id = assignPerson(d, people); if (!id) continue;
        const a = (acc[id] ||= { n: 0, act: 0 });
        a.n++; a.act += (typeof d.act === 'number' ? d.act : 0);
      }
    }
    const ids = Object.keys(acc).filter(id => acc[id].n >= 2);
    if (!ids.length) return null;
    ids.sort((x, y) => (acc[y].act / acc[y].n) - (acc[x].act / acc[x].n));
    return ids[0];
  }
  // The bottom panel as a per-segment SHOT. Priority: the model's explicit `bottom_person` (never the featured
  // person twice) → the most-present central participant that isn't featured (duo default) → with `bottom_zoom`
  // alone, a punch into the base cam (legacy corner-cam clips). null = no valid bottom shot.
  // CONTINUITY GUARDS (the same-person-top-and-bottom bug): the candidate must (a) be measurably ON SCREEN
  // during THIS segment (personPosIn — clip-wide average positions are meaningless under IRL camera motion),
  // (b) sit at least PERSON_R away from the featured person's in-window position — closer than that means the
  // position clusterer split ONE moving human into two ids, or they're the same face; either way a split would
  // show the same person twice. The crop is placed at the IN-WINDOW position, not the clip average.
  function bottomBoxFor(s, absFrom, absTo) {
    const feat = s.person ? personPosIn(s.person, absFrom, absTo) : null;
    const pick = (p) => {
      if (!p) return null;
      const pos = personPosIn(p.id, absFrom, absTo);
      if (!pos) return null;                                        // not on screen in this segment
      if (feat && Math.hypot(pos.cx - feat.cx, pos.cy - feat.cy) < CFG.PERSON_R) return null;   // same human
      // graph positions carry the IN-WINDOW face size too (someone stepping closer gets a bigger crop)
      const box = scaleBox(personBox({ cx: pos.cx, cy: pos.cy, size: pos.size || p.size }), s.bottomZoom || 1);
      // KEYFRAMED FOLLOW — IRL faces MOVE; one static box is right for a single instant. Build a crop
      // keyframe per graph row (EMA-smoothed position, FIXED size so the panel doesn't breathe) — the
      // preview/render interpolate it per frame, so the bottom panel tracks the person.
      const o = sgOff(); const pts = [];
      for (const r of sgRows(absFrom, absTo)) {
        const f = r.faces.find(x => x.p === p.id); if (!f) continue;
        pts.push({ t: r.t, cx: (f.b[0] + f.b[2]) / 2, cy: (f.b[1] + f.b[3]) / 2 });
      }
      const kf = [];
      if (pts.length >= 3) {
        // LOCK-WHEN-STILL: a static frame is neater than a drifting one — only track real movement.
        const spread = Math.max(
          Math.max(...pts.map(q => q.cx)) - Math.min(...pts.map(q => q.cx)),
          Math.max(...pts.map(q => q.cy)) - Math.min(...pts.map(q => q.cy)));
        if (spread > CFG.MOVE_THRESH / 2) {
          let ex = pts[0].cx, ey = pts[0].cy;
          for (const q of pts) {
            if (Math.abs(q.cx - ex) > CFG.DEAD) ex += (q.cx - ex) * 0.45;   // dead-band: jitter never pans
            if (Math.abs(q.cy - ey) > CFG.DEAD) ey += (q.cy - ey) * 0.45;
            const bb = scaleBox(personBox({ cx: ex, cy: ey, size: pos.size || p.size }), s.bottomZoom || 1);
            kf.push({ t: +(q.t + o).toFixed(2), x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 });
          }
        }
      }
      return { box, track: kf.length >= 3 ? kf : null };
    };
    if (s.bottomPerson && s.bottomPerson !== s.person) {
      const b = pick(personById(s.bottomPerson));
      if (b) return b;                                              // invalid explicit pick falls through to the default
    }
    if (s.person) {
      const cands = buildPeople().filter(x => x.edge >= CFG.EDGE_NEAR && x.id !== s.person)
                                 .sort((x, y) => y.presence - x.presence);
      for (const cand of cands) { const b = pick(cand); if (b) return b; }
    }
    if (s.bottomZoom && s.bottomZoom !== 1) {
      const b = scaleBox(baseCamBox(), s.bottomZoom);
      return b ? { box: b, track: null } : null;
    }
    return null;
  }

  let _undo = null;
  function clipKey() { const id = wzText('stream_clip_id'); return id ? ('ai_polish_undo_' + id) : null; }
  function applyPlan(plan) {
    const a = api(); if (!a) return;
    _planFacecam = (plan && plan.facecam && plan.facecam.box) ? plan.facecam : null;   // unlocks split in validate + feeds the crop
    const v = validate(plan);
    if (!v.segments.length) { console.warn('[ai-polish] plan had no valid segments'); return v; }
    // Snapshot the FULL state before — this edit overrides everything, so revert restores the whole clip.
    try { const snap = JSON.stringify(a.getState?.() || {}); _undo = snap; const k = clipKey(); if (k) localStorage.setItem(k, snap); } catch (_) {}
    injectCamIfNeeded(v.segments, _planFacecam);                         // make split/overlay renderable before clips apply
    const win = a.getSourceWindow?.(); const off = win ? win.start : 0;   // VOD: clip-local segment times → absolute source
    let out = 0;
    const clips = v.segments.map(s => {
      const c = { id: a.genClipId(), sourceStart: off + s.from, sourceEnd: off + s.to, outputStart: out,
                  override: { mode: s.mode, layout: { zoom: s.zoom, focusX: s.focusX, focusY: s.focusY }, ai: true } };
      if (s.track) {                                                    // scan-derived follow track for this clip
        const seedP = s.person ? personPosIn(s.person, off + s.from, off + s.to) : null;   // follow THAT person
        const raw = buildTrack(off + s.from, off + s.to, seedP);
        if (raw && raw.length >= 2) { c.override.tracking = { enabled: true, raw, mode: 'face' }; console.log('[ai-polish] track', s.from.toFixed(1) + '–' + s.to.toFixed(1) + 's', raw.length + 'pts'); }
      } else if (s.person && s.mode === 'is-full' && sceneGraph()) {
        // AUTO-TRACK: a static focus is right for one instant only — if the graph shows the featured person
        // MOVING through this segment, attach a follow-track even though the model didn't ask for one.
        const fs = sgRows(off + s.from, off + s.to).map(r => r.faces.find(f => f.p === s.person)).filter(Boolean);
        if (fs.length >= 4) {
          const xs = fs.map(f => (f.b[0] + f.b[2]) / 2), ys = fs.map(f => (f.b[1] + f.b[3]) / 2);
          const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
          if (spread > CFG.MOVE_THRESH) {
            const raw = buildTrack(off + s.from, off + s.to, personPosIn(s.person, off + s.from, off + s.to));
            if (raw && raw.length >= 2) {
              c.override.tracking = { enabled: true, raw, mode: 'face' };
              console.log('[ai-polish] auto-track ' + s.from.toFixed(1) + 's — ' + s.person + ' moves ' + spread.toFixed(2));
            }
          }
        }
      }
      // SPLIT bottom panel — a composable PER-CLIP shot (override.facecam, the same field drag/wheel set):
      // explicit bottom_person > the non-featured participant > (bottom_zoom alone) a punch into the base cam.
      // Because it's per-clip, the bottom panel swaps/reframes as the plan alternates across shots.
      // GUARANTEE: every AI split either composes a valid two-subject shot or ISN'T a split — no static-average
      // fallback in this path (the clip-wide duo base was the last source of same-person/wrong-place bottoms).
      if (s.mode === 'is-split') {
        try {
          let sEff = s;
          // Personless split in a duo scene: SELF-HEAL — infer the featured person (most face-active ≈ the
          // speaker) and give the clip the full duo treatment: top punches on them, bottom rides the other.
          if (!s.person) {
            const sp = activePersonIn(off + s.from, off + s.to);
            let pos = sp && personPosIn(sp, off + s.from, off + s.to);
            // Never self-heal onto the CAM person: on a gaming clip the only "person" IS the corner cam —
            // punching the top on them while the bottom rides the base crop shows the cam twice. A person-
            // less split there is intentional (gameplay top / cam bottom): leave it alone.
            const _cb = baseCamBox();
            if (pos && _cb && pos.cx > _cb.x1 && pos.cx < _cb.x2 && pos.cy > _cb.y1 && pos.cy < _cb.y2) pos = null;
            if (sp && pos) {
              sEff = { ...s, person: sp };
              const z = Math.max(CFG.ZOOM_MIN, Math.min(CFG.ZOOM_MAX, s.zoom > 1 ? s.zoom : CFG.TRACK_PUNCH));
              const m = 0.5 / z;
              c.override.layout = { zoom: z, focusX: Math.max(m, Math.min(1 - m, pos.cx)), focusY: Math.max(m, Math.min(1 - m, pos.cy)) };
              console.log('[ai-polish] split ' + s.from.toFixed(1) + 's: inferred featured=' + sp + ' (face activity)');
            }
          }
          const bb = bottomBoxFor(sEff, off + s.from, off + s.to);
          const box = bb && bb.box;
          // SEPARABILITY GUARANTEE — the two panels must show DISJOINT subjects. But the guard is
          // GENERATIVE first: when the bottom subject would appear in the top view, TIGHTEN the top punch
          // on the featured person until the bottom subject is excluded (what a real editor does). Only
          // when no zoom can separate them (or the featured face sits inside the bottom crop) is it a clash.
          let clash = null;
          if (box && sEff.person) {
            const featPos = personPosIn(sEff.person, off + s.from, off + s.to);
            const lay = c.override.layout;
            if (featPos && featPos.cx > box.x1 - 0.02 && featPos.cx < box.x2 + 0.02 &&
                featPos.cy > box.y1 - 0.02 && featPos.cy < box.y2 + 0.02) {
              clash = 'featured face inside bottom crop';
            } else if (lay && featPos) {
              const bcx = (box.x1 + box.x2) / 2, bcy = (box.y1 + box.y2) / 2;
              const inTop = () => {
                const span = (0.5 / Math.max(1, lay.zoom)) * 0.9;   // the top shows ~1/zoom around focus
                return Math.abs(bcx - lay.focusX) < span && Math.abs(bcy - lay.focusY) < span;
              };
              if (!(lay.zoom > 1.1) || inTop()) {
                // needed zoom so the bottom subject falls OUTSIDE the top's span (on its wider axis)
                const sep = Math.max(Math.abs(bcx - featPos.cx), Math.abs(bcy - featPos.cy), 0.01);
                const needZ = 0.45 / sep;
                if (needZ <= CFG.ZOOM_MAX) {
                  lay.zoom = +Math.max(lay.zoom, needZ).toFixed(2);
                  const m = 0.5 / lay.zoom;
                  lay.focusX = +Math.max(m, Math.min(1 - m, featPos.cx)).toFixed(3);
                  lay.focusY = +Math.max(m, Math.min(1 - m, featPos.cy)).toFixed(3);
                  if (inTop()) clash = 'subjects too close to separate';
                  else console.log('[ai-polish] split ' + s.from.toFixed(1) + 's: tightened top punch to z' + lay.zoom + ' to exclude bottom subject');
                } else clash = 'subjects too close to separate (needed z' + needZ.toFixed(1) + ')';
              }
            } else if (!lay || !(lay.zoom > 1.1)) {
              clash = 'top frame is wide — it contains the bottom subject';
            }
          }
          if (box && !clash) {
            c.override.facecam = box;
            if (bb.track) c.override.facecamTrack = bb.track;       // panel FOLLOWS the person (keyframed)
            console.log('[ai-polish] split bottom ' + s.from.toFixed(1) + 's:',
              (sEff.bottomPerson && sEff.bottomPerson !== sEff.person) ? sEff.bottomPerson : (sEff.person ? 'other-of-' + sEff.person : 'base-cam'),
              sEff.bottomZoom ? 'z' + sEff.bottomZoom : '', bb.track ? '(tracked, ' + bb.track.length + ' keys)' : '(static)');
          } else if (isRealOverlayCam() && baseCamBox()) {
            // A REAL static overlay cam (gaming) — riding the base crop is correct and always disjoint.
            console.log('[ai-polish] split ' + s.from.toFixed(1) + 's — ' + (clash || 'no person bottom') + '; riding real overlay cam');
          } else {
            // IRL / no real cam: a static box would show walls and scalps (the door-panel screenshots).
            // FORCE FULL ON THE TARGET — featured punch when framed, honest wide otherwise.
            c.override.mode = 'is-full';
            console.log('[ai-polish] split→full ' + s.from.toFixed(1) + 's — ' + (clash || 'no distinct 2nd subject on screen'));
          }
          // else: a REAL cam exists — the clip rides the base crop (legacy corner-cam split), which is correct.
        } catch (e) {
          // Composition must never kill the whole apply — the clip falls back (base crop or applyMode's own
          // split→full coercion) and the rest of the edit lands.
          console.warn('[ai-polish] split compose failed at ' + s.from.toFixed(1) + 's — clip falls back', e);
        }
      }
      out += s.to - s.from;
      return c;
    });
    a.setClips(clips, false);                                            // false → clean override (don't merge prior overrides)
    if (v.title) { a.setTitle?.(v.title); a.setTitleVisible?.(true); }
    applyFeatures(plan, a);                                              // v2 feature modules (music, …) — from the un-validated plan sections
    document.querySelector('[data-track="video"]')?._nleRebuild?.();
    window._canvasPersistTrySave?.();
    console.log('[ai-polish] applied', { segments: v.segments.length, title: v.title || '(kept existing)' });
    return v;
  }
  function revert() {
    const a = api(); if (!a) return;
    let snap = _undo;
    try { const k = clipKey(); const s = k && localStorage.getItem(k); if (s) snap = s; } catch (_) {}
    if (!snap) { console.warn('[ai-polish] nothing to revert'); return; }
    try { window.restoreCanvasState?.(JSON.parse(snap)); } catch (e) { console.error('[ai-polish] revert failed', e); return; }
    try { const k = clipKey(); if (k) localStorage.removeItem(k); } catch (_) {}
    _undo = null;
    console.log('[ai-polish] reverted');
  }

  // Accept a plan in ANY shape the webhook/Wized hands back — peel wrappers until we reach `{segments}`:
  //   • the plan object itself                              { segments, title }
  //   • a JSON string (with or without ```json fences)
  //   • a raw Gemini envelope                               candidates[0].content.parts[0].text
  //   • n8n / webhook nesting                               { json|body|data|output|response|result: … }
  //   • array-wrapped items (n8n loves arrays)              [ { … } ]
  function coercePlan(p) {
    for (let i = 0; i < 8 && p != null; i++) {
      if (typeof p === 'string') { try { p = JSON.parse(p.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); } catch (_) { return {}; } continue; }
      if (Array.isArray(p)) { p = p[0]; continue; }
      if (typeof p !== 'object') break;
      if (p.segments) return p;                                              // ← the plan
      const txt = p.candidates?.[0]?.content?.parts?.[0]?.text;             // raw Gemini envelope
      if (txt != null) { p = txt; continue; }
      const nest = p.json ?? p.body ?? p.data ?? p.output ?? p.response ?? p.result;
      if (nest != null && nest !== p) { p = nest; continue; }
      break;
    }
    return (p && p.segments) ? p : {};
  }

  // ── DETERMINISTIC BEATS GENERATOR (lab port) ─────────────────────────────────
  // The lab's conversation grammar as a local plan generator: diarized turns → word-snapped beats →
  // context (duo/joint/tight-duo/solo) → two-face DEFAULT (split or letterbox) with a solo punch every
  // SOLO_EVERY-th beat, zoom escalation through a turn, a reaction cutaway at the listener's measured
  // mouth-motion peak, and a variety guard. Splits carry a HARD rect overlap-refusal — coordinates that
  // overlap can never split. Emits the SAME segment schema the webhook returns, so it rides validate()
  // + applyPlan() (bottom composition, tracking, letterbox translation) unchanged. No LLM, no network.
  function generatePlan(opts = {}) {
    const g = sceneGraph();
    if (!g || !g.timeline || !g.persons) { console.warn('[ai-polish] auto: needs a scene graph'); return { segments: [] }; }
    const off = api()?.getSourceWindow?.()?.start || 0;
    const srcDur = sourceDuration() || 0;
    const words = readTranscript();
    if (!words.length || !words[0].speaker) { console.warn('[ai-polish] auto: needs a diarized transcript'); return { segments: [] }; }
    const spk2p = g.speakers || {};
    const mmIn = (pid, a, b) => {
      let s = 0, n = 0;
      for (const r of sgRows(off + a, off + b)) for (const f of r.faces) if (f.p === pid) { s += f.mm || 0; n++; }
      return n ? s / n : 0;
    };
    // hard overlap-refusal: tighten the top punch until it excludes the bottom crop, else no split
    const splitZoom = (fp, op, z) => {
      const bot = personBox({ cx: op.cx, cy: op.cy, size: op.size });
      const ovl = zz => {
        const vw2 = 1 / zz, vh2 = Math.min(1, vw2 * 1.58);        // 16:9 cover-drawn into the half-panel
        const x1 = Math.max(0, Math.min(1 - vw2, fp.cx - vw2 / 2));
        const y1 = Math.max(0, Math.min(1 - vh2, fp.cy - vh2 / 2));
        const iw = Math.max(0, Math.min(x1 + vw2, bot.x2) - Math.max(x1, bot.x1));
        const ih = Math.max(0, Math.min(y1 + vh2, bot.y2) - Math.max(y1, bot.y1));
        return (iw * ih) / Math.max(1e-6, (bot.x2 - bot.x1) * (bot.y2 - bot.y1));
      };
      let zz = Math.max(CFG.TRACK_PUNCH, Math.min(CFG.ZOOM_MAX, z));
      while (ovl(zz) > CFG.OVERLAP_MAX && zz < CFG.ZOOM_MAX) zz += 0.1;
      return ovl(zz) <= CFG.OVERLAP_MAX ? +Math.min(CFG.ZOOM_MAX, zz).toFixed(2) : null;
    };
    // letterbox sized off the REAL horizontal extent of everyone on screen; no faces / wide spread = full band
    const letterboxSeg = (a, b, pA, pB) => {
      let minX = 1, maxX = 0, nf = 0;
      for (const r of sgRows(off + a, off + b)) for (const f of r.faces) {
        minX = Math.min(minX, f.b[0]); maxX = Math.max(maxX, f.b[2]); nf++;
      }
      const span = nf ? Math.max(0.05, maxX - minX) : 1;
      const lz = (!nf || span > CFG.LB_SPAN_FULL) ? 1 : Math.max(1, Math.min(CFG.LB_MAX, 0.86 / Math.max(span, 0.45)));
      return { from: a, to: b, mode: 'is-letterbox', lzoom: +lz.toFixed(2),
               focusX: (pA && pB) ? +((pA.cx + pB.cx) / 2).toFixed(3) : 0.5 };
    };
    // 1. turns: contiguous same-speaker word runs; silence tiles into the previous turn (no cutting here)
    const turns = [];
    for (const w of words) {
      const t0 = w.start / 1000, t1 = w.end / 1000, sp = w.speaker || '?';
      const last = turns[turns.length - 1];
      if (last && last.sp === sp && t0 - last.to < 1.4) last.to = t1;
      else turns.push({ sp, from: t0, to: t1 });
    }
    for (let i = 0; i < turns.length - 1; i++) turns[i].to = turns[i + 1].from;
    if (turns.length) { turns[0].from = 0; if (srcDur) turns[turns.length - 1].to = srcDur; }
    const merged = [];
    for (const t of turns) {
      const last = merged[merged.length - 1];
      if (last && (t.to - t.from) < CFG.MIN_SEG) last.to = t.to;
      else merged.push({ ...t });
    }
    // INTENT MODE (n8n v3): restrict beats to the LLM's kept ranges (its trims/cuts/reorder) and carry
    // each range's `feature` intent into the grammar. Output order FOLLOWS the keep list, so reorders work.
    let work = merged;
    const keep = Array.isArray(opts.keep) && opts.keep.length ? opts.keep : null;
    if (keep) {
      work = [];
      keep.forEach((r, ri) => {
        const rf = Math.max(0, +r.from || 0), rt = Math.min(srcDur || Infinity, +r.to || 0);
        if (rt - rf < CFG.MIN_SEG) return;
        for (const t of merged) {
          const a = Math.max(t.from, rf), b = Math.min(t.to, rt);
          const prev = work[work.length - 1];
          if (b - a >= CFG.MIN_SEG) work.push({ sp: t.sp, from: a, to: b, feature: r.feature || null, fperson: r.person || null, _r: ri });
          else if (b > a && prev && prev._r === ri && Math.abs(prev.to - a) < 1e-3) prev.to = b;   // tiny tail rides the neighbour
        }
      });
      if (!work.length) { console.warn('[ai-polish] intents: kept ranges left no playable turns'); return { segments: [] }; }
    }
    // 2. word-gap snapping — cuts land between words, never mid-syllable
    const gaps = [];
    for (let i = 0; i < words.length - 1; i++) {
      const e = words[i].end / 1000, s = words[i + 1].start / 1000;
      if (s - e > 0.12) gaps.push((e + s) / 2);
    }
    const snap = t => { let best = t, bd = 0.45; for (const gp of gaps) { const d = Math.abs(gp - t); if (d < bd) { bd = d; best = gp; } } return best; };
    // 3. beats
    const segs = [];
    for (const t of work) {
      const feat = spk2p[t.sp] || null;
      const featPos = feat && personPosIn(feat, off + t.from, off + t.to);
      const others = g.persons.filter(p => p.id !== feat && personPosIn(p.id, off + t.from, off + t.to))
                              .sort((a, b) => (b.presence || 0) - (a.presence || 0));
      const other = others[0] ? others[0].id : null;
      const otherPos = other && personPosIn(other, off + t.from, off + t.to);
      const dur = t.to - t.from;
      let bounds = [t.from, t.to];
      if (dur > CFG.BEAT_SPLIT_MIN) {
        const n = Math.max(2, Math.min(5, Math.round(dur / 3)));
        bounds = [t.from];
        for (let i = 1; i < n; i++) bounds.push(snap(t.from + dur * i / n));
        bounds.push(t.to);
        bounds = bounds.filter((x, i, arr) => i === 0 || x - arr[i - 1] > CFG.MIN_SEG);
        if (bounds[bounds.length - 1] !== t.to) {
          if (t.to - bounds[bounds.length - 1] > CFG.MIN_SEG) bounds.push(t.to);
          else bounds[bounds.length - 1] = t.to;
        }
      }
      let ctx = 'solo', sep = 0, needZ = 99;
      const camB = isRealOverlayCam() ? baseCamBox() : null;
      const inCam = p => p && camB && p.cx > camB.x1 && p.cx < camB.x2 && p.cy > camB.y1 && p.cy < camB.y2;
      if (featPos && otherPos) {
        sep = Math.hypot(featPos.cx - otherPos.cx, featPos.cy - otherPos.cy);
        needZ = 0.45 / Math.max(sep, 0.01);
        const joint = mmIn(feat, t.from, t.to) > 0.1 && mmIn(other, t.from, t.to) > 0.1;
        // separability wins: letterbox is the fallback for same-region panels, not the default
        ctx = (needZ <= CFG.ZOOM_MAX && sep > CFG.PERSON_R) ? 'duo' : (joint ? 'joint' : 'tight-duo');
      } else if (camB && !otherPos && (!featPos || inCam(featPos))) {
        // GAMING CLIP (real overlay cam, nobody else on screen): split gameplay/cam is the RESTING state,
        // full-wide gameplay is the accent, and the reaction beat blows the cam person up full-screen.
        ctx = 'cam';
      } else if (!featPos) ctx = otherPos ? 'unbound' : 'blind';
      const camP = ctx === 'cam' ? (feat || (g.facecam && g.facecam.primary_person) || (g.persons[0] && g.persons[0].id)) : null;
      // reaction cutaway: the listener's (or cam person's) most animated non-first beat
      const reactOn = other || camP;
      let reactIdx = -1;
      if (reactOn && bounds.length > 2) {
        let best = 0.09;
        for (let i = 1; i < bounds.length - 1; i++) {
          const m = mmIn(reactOn, bounds[i], bounds[i + 1]);
          if (m > best) { best = m; reactIdx = i; }
        }
      }
      console.log('[ai-polish] turn ' + t.from.toFixed(1) + '–' + t.to.toFixed(1) + 's ' + t.sp + '→' + (feat || '?') +
                  ' ctx=' + ctx + (sep ? ' sep=' + sep.toFixed(2) + ' needZ=' + needZ.toFixed(1) : '') +
                  ' beats=' + (bounds.length - 1));
      for (let i = 0; i < bounds.length - 1; i++) {
        const a = bounds[i], b = bounds[i + 1];
        const esc = CFG.TRACK_PUNCH + i * 0.15;
        const solo = i > 0 && i % CFG.SOLO_EVERY === CFG.SOLO_EVERY - 1;
        let s = null;
        // FEATURE INTENT (LLM, per kept range) wins over the default weave — the model says WHAT the
        // range is for; geometry still comes from the measured grammar (never from the model).
        const feature = t.feature || null;
        if (feature === 'wide') {
          s = { from: a, to: b, mode: 'is-full', zoom: 1 };
        } else if (feature === 'letterbox') {
          s = letterboxSeg(a, b, featPos, otherPos);
        } else if (feature === 'punch' && (t.fperson || feat)) {
          s = { from: a, to: b, mode: 'is-full', person: t.fperson || feat, zoom: +Math.min(CFG.ZOOM_MAX, esc).toFixed(2) };
        } else if (feature === 'reaction' && (t.fperson || reactOn)) {
          s = { from: a, to: b, mode: 'is-full', person: t.fperson || reactOn,
                zoom: +Math.min(CFG.ZOOM_MAX, ctx === 'cam' ? 2.0 : CFG.TRACK_PUNCH + 0.2).toFixed(2), react: true };
        } else if (feature === 'split') {
          if (ctx === 'cam') s = { from: a, to: b, mode: 'is-split', zoom: +Math.min(1.3, 1 + i * 0.06).toFixed(2) };
          else if (featPos && otherPos) {
            const z = splitZoom(featPos, otherPos, Math.max(CFG.TRACK_PUNCH, Math.min(CFG.ZOOM_MAX, needZ)) + i * 0.06);
            s = z ? { from: a, to: b, mode: 'is-split', person: feat, bottom_person: other, zoom: z }
                  : letterboxSeg(a, b, featPos, otherPos);          // asked for split, geometry says no → letterbox
          }
        }
        if (!s)
        if (i === reactIdx && reactOn) {
          s = { from: a, to: b, mode: 'is-full', person: reactOn,
                zoom: +Math.min(CFG.ZOOM_MAX, ctx === 'cam' ? 2.0 : CFG.TRACK_PUNCH + 0.2).toFixed(2), react: true };
        } else if (ctx === 'cam') {
          // split (no person → validate centres the top, applyPlan rides the base cam) ↔ full-wide accent
          s = solo ? { from: a, to: b, mode: 'is-full', zoom: 1 }
                   : { from: a, to: b, mode: 'is-split', zoom: +Math.min(1.3, 1 + i * 0.06).toFixed(2) };
        } else if (ctx === 'duo') {
          if (solo) s = { from: a, to: b, mode: 'is-full', person: feat, zoom: +Math.min(CFG.ZOOM_MAX, esc).toFixed(2) };
          else {
            const z = splitZoom(featPos, otherPos, Math.max(CFG.TRACK_PUNCH, Math.min(CFG.ZOOM_MAX, needZ)) + i * 0.06);
            if (!z) console.log('[ai-polish] split refused (overlap) ' + a.toFixed(1) + 's — ' + feat + '/' + other + ' sep=' + sep.toFixed(2) + ' → letterbox');
            s = z ? { from: a, to: b, mode: 'is-split', person: feat, bottom_person: other, zoom: z }
                  : letterboxSeg(a, b, featPos, otherPos);          // overlap-refused → letterbox
          }
        } else if (ctx === 'joint' || ctx === 'tight-duo') {
          if (!solo) s = letterboxSeg(a, b, featPos, otherPos);
          else {
            const hot = mmIn(feat, a, b) >= mmIn(other, a, b) ? feat : other;
            s = { from: a, to: b, mode: 'is-full', person: hot, zoom: +Math.min(CFG.ZOOM_MAX, esc + 0.15).toFixed(2) };
          }
        } else if (ctx === 'solo' && featPos) {
          s = { from: a, to: b, mode: 'is-full', person: feat, zoom: +Math.min(CFG.ZOOM_MAX, esc).toFixed(2) };
          if (i > 0 && i % 3 === 0) s.zoom = 1;                     // wide relief — let the shot breathe
        } else if (ctx === 'unbound' && otherPos) {
          s = solo ? { from: a, to: b, mode: 'is-full', person: other, zoom: +Math.min(CFG.ZOOM_MAX, esc).toFixed(2) }
                   : letterboxSeg(a, b, otherPos, null);
        }
        if (!s) s = letterboxSeg(a, b, featPos, otherPos);          // blind → full letterbox
        segs.push(s);
      }
    }
    // 4. variety guard — no two consecutive beats with the same signature
    for (let i = 1; i < segs.length; i++) {
      const sig = s => s.mode + '|' + (s.person || '') + '|' +
                       Math.round(((s.mode === 'is-letterbox' ? s.lzoom : s.zoom) || 1) * 5);
      if (sig(segs[i]) === sig(segs[i - 1])) {
        if (segs[i].mode === 'is-letterbox') segs[i].lzoom = +Math.min(CFG.LB_MAX, (segs[i].lzoom || 1) + 0.2).toFixed(2);
        else segs[i].zoom = +Math.min(CFG.ZOOM_MAX, (segs[i].zoom || 1) + 0.25).toFixed(2);
      }
    }
    console.log('[ai-polish] auto plan: ' + segs.length + ' beats (' +
      segs.filter(s => s.mode === 'is-split').length + ' split, ' +
      segs.filter(s => s.mode === 'is-letterbox').length + ' letterbox, ' +
      segs.filter(s => s.react).length + ' reaction cutaways)');
    return { segments: segs };
  }

  // Story-level INTENTS (n8n v3 contract): the LLM curates WHAT plays — ordered kept ranges (trim/cut/
  // reorder) with an optional `feature` per range (reaction|punch|wide|letterbox|split) + `person` + title —
  // and the deterministic grammar compiles HOW: beats, framing, tracking, overlap guards. The model never
  // writes zoom/focus numbers, so every shot is geometrically legal by construction.
  function applyIntents(plan) {
    stage('④', 'response handed to applyIntents (' + kb(plan) + ')');
    const p = coercePlan(plan);
    if (!p || typeof p !== 'object') { console.warn('[ai-polish] ⑤ FAILED: response did not coerce to a plan object', plan); return; }
    if (p.error) { console.warn('[ai-polish] ⑤ FAILED: n8n returned an error payload', p); return; }
    stage('⑤', 'validating: keys [' + Object.keys(p).join(', ') + ']' +
          (p.analysis ? ' — analysis: "' + String(p.analysis).slice(0, 160) + '…"' : ' — NO analysis field'));
    const FEATURES_OK = new Set(['reaction', 'punch', 'wide', 'letterbox', 'split']);
    const sp2p = (sceneGraph() && sceneGraph().speakers) || {};       // the model speaks in transcript letters (A/B)
    const gp   = (sceneGraph() && sceneGraph().persons) || [];
    let keep = (Array.isArray(p?.segments) ? p.segments : []).map(s => {
      let who = (typeof s.person === 'string' && s.person.trim()) ? s.person.trim().toUpperCase() : null;
      if (who && sp2p[who]) who = sp2p[who];                          // speaker letter → graph person id
      if (who && !gp.some(x => x.id === who)) who = null;             // unresolvable (unbound speaker) → let the grammar pick
      return { from: +s.from, to: +s.to, feature: FEATURES_OK.has(s.feature) ? s.feature : null, person: who };
    }).filter(s => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from);
    if (!keep.length) { console.warn('[ai-polish] ⑤ no valid kept ranges in response — falling back to full auto edit'); return applyPlan(generatePlan()); }
    // CONSOLIDATE — the model tends to emit per-transcript-line slivers and micro-cuts. Deterministic repair:
    // ① contiguous/near-contiguous ranges (hole ≤ 0.5s) MERGE into one scene — a sub-second hole reads as a
    // glitch, not an edit (the wall-kiss shredding); the earlier range's intent wins for the joined stretch.
    // ② any surviving sub-MIN_SEG sliver is ABSORBED into its neighbour instead of being dropped by validate
    // (dropped slivers = silently missing content). Only an isolated sliver (real cuts both sides) stays put.
    const merged = [];
    for (const r of keep) {
      const last = merged[merged.length - 1];
      if (last && r.from - last.to <= 0.5 &&
          ((r.feature || null) === (last.feature || null) && (r.person || null) === (last.person || null)
           || (r.to - r.from) < CFG.MIN_SEG)) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }
    for (let i = 0; i < merged.length; i++) {
      const r = merged[i];
      if (r.to - r.from >= CFG.MIN_SEG) continue;
      const prev = merged[i - 1], next = merged[i + 1];
      if (prev && r.from - prev.to <= 0.5) { prev.to = r.to; merged.splice(i--, 1); }
      else if (next && next.from - r.to <= 0.5) { next.from = r.from; merged.splice(i--, 1); }
    }
    if (merged.length !== keep.length)
      stage('⑤', 'consolidated ' + keep.length + ' model ranges → ' + merged.length + ' scenes (slivers merged, micro-cuts bridged)');
    keep = merged;
    keep.forEach((k, i) => stage('⑤', 'range ' + (i + 1) + '/' + keep.length + ': ' + k.from.toFixed(1) + '–' + k.to.toFixed(1) + 's' +
      (k.feature ? ' [' + k.feature + (k.person ? ' ' + k.person : '') + ']' : ' [default grammar]')));
    const det = generatePlan({ keep });
    if (typeof p.title === 'string' && p.title.trim()) det.title = p.title.trim();
    // feature sections (music/sfx/images/text styling) ride the plan into applyFeatures unchanged
    for (const k of ['music', 'sfx', 'images', 'title_style', 'subtitle_style', 'title_zone', 'subtitle_zone', 'title_in', 'title_out'])
      if (p[k] != null) det[k] = p[k];
    // ANCHORS: sfx/image cues may cite a storyboard cell (anchor:"C7") instead of doing output-time
    // arithmetic — cell → source time (stashed digest) → output time via the kept ranges. Measured, not guessed.
    try {
      const cells = (window.__aiDigest && window.__aiDigest.storyboard && window.__aiDigest.storyboard.cells) || [];
      const srcToOut = st => {
        let acc = 0;
        for (const r of keep) {
          if (st >= r.from - 0.25 && st <= r.to + 0.25) return acc + Math.max(0, Math.min(st, r.to) - r.from);
          acc += r.to - r.from;
        }
        return null;
      };
      const resolve = (arr, kind) => {
        if (!Array.isArray(arr)) return;
        for (const c of arr) {
          if (!c || !c.anchor) continue;
          const cell = cells.find(x => x.cell === String(c.anchor).toUpperCase().trim());
          const ot = cell ? srcToOut(cell.t) : null;
          if (ot == null) continue;
          if (kind === 'at') c.at = +ot.toFixed(2);
          else { const d = Math.max(1, (+c.to - +c.from) || 2); c.from = +ot.toFixed(2); c.to = +(ot + d).toFixed(2); }
          console.log('[ai-polish] anchor ' + c.anchor + ' → output ' + ot.toFixed(1) + 's');
        }
      };
      resolve(det.sfx, 'at'); resolve(det.images, 'range');
    } catch (_) {}
    const keptDur = keep.reduce((a, k) => a + (k.to - k.from), 0);
    const beatDur = (det.segments || []).reduce((a, s) => a + (s.to - s.from), 0);
    stage('⑤', 'compiled: ' + keep.length + ' kept ranges (' + keptDur.toFixed(1) + 's) → ' + (det.segments || []).length +
          ' beats (' + beatDur.toFixed(1) + 's)' + (Math.abs(keptDur - beatDur) > 1.5 ? ' ⚠ durations diverge — check MIN_SEG drops above' : ''));
    const res = applyPlan(det);
    // ⑥ CONFORMANCE — did what LANDED match what was returned?
    try {
      const applied = (res && res.segments) || [];
      const appliedDur = applied.reduce((a, s) => a + (s.to - s.from), 0);
      const modes = {};
      for (const s of applied) { const m = s.letterbox ? 'letterbox' : s.mode; modes[m] = (modes[m] || 0) + 1; }
      stage('⑥', 'APPLIED: ' + applied.length + ' clips, output ' + appliedDur.toFixed(1) + 's of ' + keptDur.toFixed(1) + 's kept — ' +
            Object.entries(modes).map(([k2, v2]) => k2 + '×' + v2).join(', ') +
            (det.title ? ' — title: "' + det.title + '"' : '') +
            ((det.sfx || []).length ? ' — sfx×' + det.sfx.length : '') +
            ((det.images || []).length ? ' — images×' + det.images.length : ''));
      if (!applied.length) console.warn('[ai-polish] ⑥ NOTHING APPLIED — every beat was dropped in validate (check MIN_SEG / mode constraints)');
    } catch (_) {}
    return res;
  }

  // ── webhook (client-driven path) ───────────────────────────────────────────────
  async function fetchPlan(digest) {
    if (!CFG.url) throw new Error('set window.aiDirectorCfg.url to your n8n webhook');
    stage('③', 'POST → ' + CFG.url + ' (' + kb(digest) + ')');
    const t0 = performance.now();
    const res = await fetch(CFG.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(digest) });
    if (!res.ok) throw new Error('webhook ' + res.status);
    const raw = await res.json();
    stage('④', 'response received in ' + ((performance.now() - t0) / 1000).toFixed(1) + 's (' + kb(raw) + ')');
    const plan = coercePlan(raw);
    if (!plan.segments) throw new Error('unrecognised webhook response');
    return plan;
  }

  // window.aiPolish()         → digest → webhook → validate → rebuild (revertible)
  // window.aiPolish.dryRun(p) → rebuild from a hand-pasted EDIT PLAN (test the applier WITHOUT the webhook)
  // window.aiPolish.digest()  → build + return the digest (inspect what we'd send)
  // window.aiPolish.validate(p) / .revert()
  async function run() { const d = await buildDigest(); if (!d) return; return applyPlan(await fetchPlan(d)); }
  window.aiPolish = run;                                              // client-driven: digest → webhook → apply, in one call

  // Wized-driven flow (button → JS action → perform request → JS action):
  //   1) `await window.aiPolish.digest()` builds the digest (runs the scan) and STASHES it to
  //      window.__aiDigest; it also RETURNS it, so a Wized JS action can `return` it into a variable.
  //   2) your Wized "perform request" sends that stash/variable as the body (the scan is inside it).
  //   3) on success, `window.aiPolish.apply(<response plan>)` rebuilds the clip.
  window.aiPolish.digest   = async () => {
    const d = await buildDigest();
    window.__aiDigest = d;
    if (d) stage('②', 'digest stashed to window.__aiDigest (' + kb(d) + ') — send it via the webhook now (③ is your Wized request)');
    return d;
  };
  window.aiPolish.apply    = (plan) => applyPlan(coercePlan(plan));  // apply the webhook response (parsed plan OR raw Gemini envelope)
  window.aiPolish.dryRun   = (plan) => applyPlan(coercePlan(plan));  // apply a hand-pasted plan to test
  window.aiPolish.validate = (plan) => validate(plan);
  window.aiPolish.revert   = revert;
  window.aiPolish.auto     = () => applyPlan(generatePlan());        // deterministic beats edit — no LLM, no network
  window.aiPolish.plan     = generatePlan;                           // inspect the generated plan without applying
  window.aiPolish.applyIntents = applyIntents;                       // n8n v3: LLM keep-ranges + feature intents → beats

  // ── button ([data-ai-polish]) — separate from Smart Edits; toggles apply ⇄ revert ──
  function boot() {
    const btn = document.querySelector('#ai_polish_button, [wized="ai_polish_button"], [data-ai-polish]');
    if (!btn) { setTimeout(boot, 500); return; }
    if (btn._aiBound) return; btn._aiBound = true;
    let busy = false;
    const sync = (applied) => {
      btn.classList.toggle('is-requesting', busy);
      btn.classList.toggle('has-polished', !busy && !!applied);
      btn.dataset.ai = busy ? 'requesting' : applied ? 'polished' : 'idle';
    };
    sync(false);
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (busy) return;
      if (_undo) { revert(); sync(false); return; }                      // applied → this click reverts
      busy = true; sync(false);
      try { await run(); busy = false; sync(true); }
      catch (err) { console.error('[ai-polish] failed', err); busy = false; sync(false); }
    });
    console.log('[ai-polish] button ready (autonomous editor)');
  }
  boot();
})();