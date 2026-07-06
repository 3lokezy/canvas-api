(function () {
  'use strict';

  // ── Editor perf guard: stop Wized's PostHog session-replay (rrweb) from recording the heavy canvas +
  // timeline DOM. PostHog records EVERY DOM mutation; the per-frame playhead + canvas style churn floods it →
  // judder/OOM (only inside the Wized editor — app.wized.com; published/prod never records). The `ph-no-capture`
  // class makes rrweb skip these subtrees (it checks ancestors per mutation, so it works even added post-load).
  // Harmless everywhere PostHog isn't running. Tag on load + a few retries to catch late-mounting editor DOM.
  (function _blockReplayOnHeavyDom() {
    const SEL = '.clip_canvas, [data-canvas], #timeline_container, [data-track], #tl_playhead, [data-trackbar], [data-modebar]';
    const tag = () => { try { document.querySelectorAll(SEL).forEach(el => el.classList.add('ph-no-capture')); } catch (_) {} };
    if (document.readyState !== 'loading') tag(); else document.addEventListener('DOMContentLoaded', tag);
    [400, 1200, 3000, 6000].forEach(ms => setTimeout(tag, ms));
  })();

  const ZOOM_MAX  = 4;
  const ZOOM_STEP = 0.10;
  // Touch device (no hover) → resize handles must stay visible + be big enough to tap.
  const _COARSE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  // iOS can't play a canvas captureStream in a <video> (renders black) → the blurred
  // letterbox bg is drawn from the engine frame into a canvas instead.
  const _IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
               || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  let _sourceBounds = null;

  // ── Soundboard (one-shot meme-sound track) — swappable behaviour knobs ─────────
  // Kept module-top so they're easy to find + flip while testing.
  const SOUNDBOARD_ANCHOR  = 'output';   // 'output' = a sound sits at a FIXED timeline position |
                                         // 'source' = it's pinned to the footage and follows cuts/reorder.
                                         // Isolated to one resolver in getSoundboardCues — flip this, nothing else changes.
  const SOUNDBOARD_GAIN    = 0.65;       // master duck — every snippet rides one gain so they sit under clip/music audio
  const SOUNDBOARD_MIN_GAP = 0.001;      // s — drop cues whose effective length collapses (a later sound lands on top)
  const IMAGE_DEFAULT_DUR  = 3;          // s — default on-screen duration for a placed image pop-up (matches the ≤3s rule)
  // Decode once per url. duration is sample-rate-independent so it's correct from any context; but step-2
  // SCHEDULING must put the buffer on the ENGINE's AudioContext (match its sample rate) or a 44100→48000
  // mismatch plays it ~9% fast — re-decode there if the cached buffer's rate differs from the engine's.
  const _sbBufferCache = new Map();      // url -> AudioBuffer
  let _sbStandaloneCtx = null;
  function _sbDecodeCtx() {
    const eng = window.wcEngine?.audioContext?.();
    if (eng) return eng;
    if (!_sbStandaloneCtx) { try { _sbStandaloneCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    return _sbStandaloneCtx;
  }
  async function _sbDecode(url) {
    if (_sbBufferCache.has(url)) return _sbBufferCache.get(url);
    const ctx = _sbDecodeCtx();
    if (!ctx) throw new Error('no AudioContext');
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch ' + res.status);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    _sbBufferCache.set(url, buf);
    return buf;
  }

  // ── Overlay FX (colour-flash / desaturate "moments") ───────────────────────────
  // Translucent, full-frame visual feedback pulses — usually fired alongside a soundboard
  // sound (ding → green / money, error → red / damage, hype → purple, defeat → desaturate).
  // Output-time anchored like the soundboard. ONE cue list is the single source of truth,
  // read by BOTH the live preview sampler (DOM, step 2) and the render compositor (canvas,
  // step 3) through fxIntensityAt() — so the two surfaces can't drift, and the render captures
  // them FREE (drawn straight into drawCanvasFrame), the visual twin of the soundboard tap.
  const FX_PRESETS = {
    'green-flash':  { kind: 'flash', color: '#22e36a', dur: 0.5, peak: 0.55 },   // success / money
    'red-flash':    { kind: 'flash', color: '#ff2e2e', dur: 0.5, peak: 0.55 },   // bad / damage
    'purple-flash': { kind: 'flash', color: '#a855f7', dur: 0.5, peak: 0.55 },   // hype / rare
    'desaturate':   { kind: 'desat', color: null,      dur: 2.2, peak: 1.0  },   // bleak / defeat — holds, then resumes
  };
  // Intensity envelope 0..1 for a cue, `e` seconds after its start. Flashes snap in then decay
  // fast (easeOut); desaturate eases in (~0.15s), HOLDS, then releases (~0.5s) back to colour.
  function _fxEnv(kind, e, dur) {
    if (e <= 0 || e >= dur) return 0;
    if (kind === 'desat') {
      const ATK = 0.15, REL = 0.5;
      if (e < ATK)       return e / ATK;
      if (e > dur - REL) return Math.max(0, (dur - e) / REL);
      return 1;
    }
    const ATK = 0.04;                    // flash
    if (e < ATK) return e / ATK;         // snap up
    const k = (e - ATK) / (dur - ATK);   // 0..1 across the decay
    return (1 - k) * (1 - k);            // easeOut decay to 0
  }

  function scaleFrame(frame) {
    const wrap = frame.parentElement;
    if (!wrap) return;
    const scale = Math.min(
      wrap.clientWidth  / frame.offsetWidth,
      (wrap.clientHeight || Infinity) / frame.offsetHeight,
      1
    );
    frame.style.transformOrigin = 'top left';
    frame.style.transform       = `scale(${scale})`;
    frame._canvasScale           = scale;
    wrap.style.height            = `${frame.offsetHeight * scale}px`;
  }
  
  function makeDraggable(handle, opts = {}) {
    const target = opts.target || handle;
    let ox = 0, oy = 0, sx = 0, sy = 0, live = false;
    const pointers = new Map();      // active pointers → {x,y} (multi-touch)
    let pinchDist = 0;               // last 2-finger distance (0 = not pinching)

    handle.style.cursor = 'grab';
    // Own touch gestures on this element so the browser doesn't treat a drag/pinch as
    // a page scroll/zoom (the core mobile bug: without this, touch-drags scrolled the
    // page and fired pointercancel). Pointer Events + touch-action:none is the robust combo.
    handle.style.touchAction = 'none';

    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}

      // Second finger → switch from pan to pinch-zoom (if this draggable supports it).
      if (opts.onPinch && pointers.size === 2) {
        live = false;
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        handle.style.cursor = 'grab';
        return;
      }
      if (pointers.size === 1) {
        const scale = opts.getScale?.() ?? 1;
        ox = parseFloat(target.style.left) || 0;
        oy = parseFloat(target.style.top)  || 0;
        sx = e.clientX / scale;
        sy = e.clientY / scale;
        live = true;
        handle.style.cursor = 'grabbing';
        opts.onStart?.();
      }
    });

    handle.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pinchDist && pointers.size >= 2) {                    // pinch-zoom
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        if (Math.abs(dist - pinchDist) > 0.5) { opts.onPinch(dist / pinchDist); pinchDist = dist; }
        return;
      }
      if (!live) return;                                        // single-finger / mouse pan
      const scale = opts.getScale?.() ?? 1;
      let nx = ox + (e.clientX / scale - sx);
      let ny = oy + (e.clientY / scale - sy);
      if (opts.clamp) [nx, ny] = opts.clamp(nx, ny);
      target.style.left = `${nx}px`;
      target.style.top  = `${ny}px`;
      opts.onMove?.(nx, ny);
    });

    const release = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;                     // dropped below 2 fingers → end pinch
      if (pointers.size === 0 && live) {
        live = false;
        handle.style.cursor = 'grab';
        opts.onEnd?.(parseFloat(target.style.left) || 0, parseFloat(target.style.top) || 0);
      }
    };
    handle.addEventListener('pointerup',     release);
    handle.addEventListener('pointercancel', release);
  }
  
  const SNAP_GUIDE_PX = 6;

  function getOrCreateGuides(frame) {
    if (!frame._snapGuideH) {
      const h = document.createElement('div');
      Object.assign(h.style, {
        position: 'absolute', left: '0', width: '100%',
        top: '50%', height: '1px',
        background: 'rgba(0,162,255,0.55)',
        pointerEvents: 'none', zIndex: '200', display: 'none',
      });
      frame.appendChild(h);
      frame._snapGuideH = h;
    }
    if (!frame._snapGuideV) {
      const v = document.createElement('div');
      Object.assign(v.style, {
        position: 'absolute', top: '0', height: '100%',
        left: '50%', width: '1px',
        background: 'rgba(0,162,255,0.55)',
        pointerEvents: 'none', zIndex: '200', display: 'none',
      });
      frame.appendChild(v);
      frame._snapGuideV = v;
    }
    return { h: frame._snapGuideH, v: frame._snapGuideV };
  }

  function snapToCenter(nx, ny, hold, frame) {
    const fw = frame.clientWidth, fh = frame.clientHeight;
    const hw = hold.offsetWidth,  hh = hold.offsetHeight;
    const cx = nx + hw / 2, cy = ny + hh / 2;
    const midX = fw / 2, midY = fh / 2;
    const guides = getOrCreateGuides(frame);
    let showH = false, showV = false;

    if (Math.abs(cx - midX) < SNAP_GUIDE_PX) { nx = midX - hw / 2; showV = true; }
    if (Math.abs(cy - midY) < SNAP_GUIDE_PX) { ny = midY - hh / 2; showH = true; }

    guides.h.style.display = showH ? '' : 'none';
    guides.v.style.display = showV ? '' : 'none';
    return [nx, ny];
  }

  function hideSnapGuides(frame) {
    if (frame._snapGuideH) frame._snapGuideH.style.display = 'none';
    if (frame._snapGuideV) frame._snapGuideV.style.display = 'none';
  }

  // Selection/resize affordance for an overlay hold: a thin outline + 4 slightly-rounded
  // square corner handles. Desktop: shown on hover OR when selected. Mobile (coarse, no
  // hover): shown ONLY while the hold is selected (tap shows them, tap-away hides them via
  // the selection system). Each corner resizes anchoring the opposite corner. Shared by
  // the image/chat overlays and the facecam.
  function _addResizeHandles(hold, frame, getScale, minW, minH, getAspect, onEnd) {
    if (hold.querySelector('[data-overlay-handle]')) return;
    const CORNERS = [
      ['nw', 0, 0, 'nwse-resize'], ['ne', 1, 0, 'nesw-resize'],
      ['sw', 0, 1, 'nesw-resize'], ['se', 1, 1, 'nwse-resize'],
    ];
    const els = [];
    let hovered = false, resizing = 0;
    const setVisible = on => {
      els.forEach(h => { h.style.opacity = on ? '1' : '0'; });
      hold.style.outline       = on ? '1.5px solid rgba(255,255,255,0.92)' : '';
      hold.style.outlineOffset = on ? '0px' : '';
    };
    const refresh = () => setVisible(resizing > 0 || hold.classList.contains('is-selected') || (!_COARSE && hovered));

    CORNERS.forEach(([id, sx, sy, cur]) => {
      const h = document.createElement('div');
      h.dataset.overlayHandle = id;
      Object.assign(h.style, {
        position: 'absolute',
        left:  sx ? 'auto' : '-6px', right:  sx ? '-6px' : 'auto',
        top:   sy ? 'auto' : '-6px', bottom: sy ? '-6px' : 'auto',
        width: '12px', height: '12px', cursor: cur,
        background: '#fff', border: '1.5px solid rgba(0,0,0,0.55)',
        borderRadius: '3px', zIndex: '10', touchAction: 'none',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        opacity: '0', transition: 'opacity .12s',
      });
      hold.appendChild(h);
      els.push(h);
      _bindCorner(h, sx, sy, hold, frame, getScale, minW, minH, getAspect, a => { resizing += a ? 1 : -1; refresh(); if (!a) onEnd?.(); });
    });

    if (!_COARSE) {
      hold.addEventListener('pointerenter', () => { hovered = true; refresh(); });
      hold.addEventListener('pointerleave', () => { hovered = false; refresh(); });
    }
    hold._resizeObs?.disconnect();   // avoid stacking observers across re-binds (facecam)
    hold._resizeObs = new MutationObserver(refresh);
    hold._resizeObs.observe(hold, { attributes: true, attributeFilter: ['class'] });
    setVisible(false);
  }

  // One corner handle. sx/sy = which edge it controls (0 = left/top, 1 = right/bottom);
  // the opposite edge stays anchored. Optional getAspect() locks the ratio (images).
  function _bindCorner(handle, sx, sy, hold, frame, getScale, minW, minH, getAspect, onActive) {
    let live = false, startX = 0, startY = 0, L0 = 0, T0 = 0, W0 = 0, H0 = 0, ar = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault(); e.stopPropagation();
      const s = getScale();
      startX = e.clientX / s; startY = e.clientY / s;
      L0 = parseFloat(hold.style.left) || 0; T0 = parseFloat(hold.style.top) || 0;
      W0 = hold.offsetWidth; H0 = hold.offsetHeight;
      ar = getAspect ? getAspect() : null;
      live = true; handle.setPointerCapture(e.pointerId); onActive(true);
    });
    handle.addEventListener('pointermove', e => {
      if (!live) return;
      const s = getScale();
      const dx = e.clientX / s - startX, dy = e.clientY / s - startY;
      const FW = frame.clientWidth, FH = frame.clientHeight;
      let L = L0, W = W0, T = T0, H = H0;
      if (sx === 0) { const right = L0 + W0; L = Math.min(right - minW, Math.max(0, L0 + dx)); W = right - L; }
      else          { W = Math.max(minW, Math.min(FW - L0, W0 + dx)); }
      if (sy === 0) { const bot = T0 + H0; T = Math.min(bot - minH, Math.max(0, T0 + dy)); H = bot - T; }
      else          { H = Math.max(minH, Math.min(FH - T0, H0 + dy)); }
      if (ar) {                                   // lock aspect (driven by width)
        H = W / ar;
        if (sy === 0) T = (T0 + H0) - H;           // grow from the fixed bottom edge
        if (T < 0) T = 0;
        if (T + H > FH) H = FH - T;
      }
      hold.style.left = `${L}px`; hold.style.top = `${T}px`;
      hold.style.width = `${W}px`; hold.style.height = `${H}px`;
    });
    const end = () => { if (!live) return; live = false; onActive(false); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function makeOverlayInteractive(hold, frame, getScale) {
    if (!hold) return;

    const draggable = hold.dataset.draggable === 'true';
    const resizable = hold.dataset.resizable === 'true';
    const minW      = parseFloat(hold.dataset.minWidth)  || 60;
    const minH      = parseFloat(hold.dataset.minHeight) || 60;

    hold.style.position = 'absolute';

    if (draggable && !hold.style.left) {
      const fr = frame.getBoundingClientRect();
      const hr = hold.getBoundingClientRect();
      hold.style.left = `${(hr.left - fr.left) / getScale()}px`;
      hold.style.top  = `${(hr.top  - fr.top)  / getScale()}px`;
      if (!hold.style.width)  hold.style.width  = `${hr.width  / getScale()}px`;
      if (!hold.style.height) hold.style.height = `${hr.height / getScale()}px`;
    }

    if (draggable) {
      let ox = 0, oy = 0, sx = 0, sy = 0, live = false;
      hold.style.cursor = 'grab';
      hold.style.touchAction = 'none';   // own touch drags → don't let the browser scroll the page

      hold.addEventListener('pointerdown', e => {
        if (e.target.dataset.overlayHandle) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        e.stopPropagation();
        ox = parseFloat(hold.style.left) || 0;
        oy = parseFloat(hold.style.top)  || 0;
        sx = e.clientX / getScale();
        sy = e.clientY / getScale();
        live = true;
        hold.setPointerCapture(e.pointerId);
        hold.style.cursor = 'grabbing';
      });

      hold.addEventListener('pointermove', e => {
        if (!live) return;
        let nx = ox + (e.clientX / getScale() - sx);
        let ny = oy + (e.clientY / getScale() - sy);
        [nx, ny] = clampHoldInFrame(nx, ny, hold, frame);
        [nx, ny] = snapToCenter(nx, ny, hold, frame);
        hold.style.left = `${nx}px`;
        hold.style.top  = `${ny}px`;
      });

      const endDrag = () => {
        if (!live) return;
        live = false;
        hold.style.cursor = 'grab';
        hideSnapGuides(frame);
      };
      hold.addEventListener('pointerup',     endDrag);
      hold.addEventListener('pointercancel', endDrag);
    }

    if (resizable) {
      _addResizeHandles(hold, frame, getScale, minW, minH, () => {
        const img = hold.querySelector('img');
        return (img?.naturalWidth && img?.naturalHeight) ? img.naturalWidth / img.naturalHeight : null;
      });
    }
  }
  
  function applyTextZones(textGroup, titleZone, subZone) {
    if (!textGroup) return;
  
    textGroup._titleZone = titleZone;
    textGroup._subZone   = subZone;
  
    textGroup.style.flexDirection = 'column';
  
    if (titleZone === subZone) {
      const map = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
      textGroup.style.height         = '100%';
      textGroup.style.top            = '0%';
      textGroup.style.justifyContent = map[titleZone];
      return;
    }
    if (titleZone === 'top' && subZone === 'middle') {
      textGroup.style.height         = '50%';
      textGroup.style.top            = '0%';
      textGroup.style.justifyContent = 'space-between';
      return;
    }
    if (titleZone === 'top' && subZone === 'bottom') {
      textGroup.style.height         = '100%';
      textGroup.style.top            = '0%';
      textGroup.style.justifyContent = 'space-between';
      return;
    }
    if (titleZone === 'middle' && subZone === 'bottom') {
      textGroup.style.height         = '50%';
      textGroup.style.top            = '50%';
      textGroup.style.justifyContent = 'space-between';
      return;
    }
    if (titleZone === 'middle' && subZone === 'top') {
      textGroup.style.height         = '50%';
      textGroup.style.top            = '0%';
      textGroup.style.justifyContent = 'space-between';
      textGroup.style.flexDirection  = 'column-reverse';
      return;
    }
    if (titleZone === 'bottom' && subZone === 'top') {
      textGroup.style.height         = '100%';
      textGroup.style.top            = '0%';
      textGroup.style.justifyContent = 'space-between';
      textGroup.style.flexDirection  = 'column-reverse';
      return;
    }
    if (titleZone === 'bottom' && subZone === 'middle') {
      textGroup.style.height         = '50%';
      textGroup.style.top            = '50%';
      textGroup.style.justifyContent = 'space-between';
      textGroup.style.flexDirection  = 'column-reverse';
      return;
    }
  }
  
  function clampHoldInFrame(x, y, hold, frame) {
    return [
      Math.max(0, Math.min(frame.clientWidth  - hold.offsetWidth,  x)),
      Math.max(0, Math.min(frame.clientHeight - hold.offsetHeight, y)),
    ];
  }

  function captureOverlayDefaults(hold, frame, getScale) {
    if (!hold || !frame) return null;
    const fw = frame.clientWidth || 0;
    const fh = frame.clientHeight || 0;
    const hw = hold.offsetWidth || 0;
    const hh = hold.offsetHeight || 0;
    if (!fw || !fh || !hw || !hh) return null;

    const scale = getScale?.() || 1;
    const fr = frame.getBoundingClientRect();
    const hr = hold.getBoundingClientRect();
    const left = (hr.left - fr.left) / scale;
    const top  = (hr.top  - fr.top)  / scale;

    return {
      scale: hw / fw,
      x: (left + hw / 2) / fw,
      y: (top + hh / 2) / fh,
      minWidth: hw,
      minHeight: hh,
    };
  }
  
  function wz(item, key) {
    return item.querySelector(`[wized="${key}"]`)?.textContent.trim() ?? '';
  }
  
  // Slight per-preset entry animation for the ACTIVE caption word. Pure function of the
  // preset id + ms-since-the-word-went-active, so preview (DOM transform) and render
  // (canvas transform) animate identically. dy is in em (of the caption font). Three
  // subtle motions mapped by the preset's numeric suffix; identity when no preset set.
  function _subAnim(styleId, tMs) {
    if (!styleId) return { scale: 1, dy: 0 };
    const n = parseInt(String(styleId).replace(/\D/g, ''), 10);
    if (!n) return { scale: 1, dy: 0 };
    const c = x => (x < 0 ? 0 : x > 1 ? 1 : x);
    const kind = (n - 1) % 3;
    if (kind === 0) {                                  // pop — quick scale-in
      const e = 1 - Math.pow(1 - c(tMs / 130), 3);
      return { scale: 0.86 + 0.14 * e, dy: 0 };
    }
    if (kind === 1) {                                  // rise — settle up from below
      const e = 1 - Math.pow(1 - c(tMs / 160), 3);
      return { scale: 0.97 + 0.03 * e, dy: 0.16 * (1 - e) };
    }
    const p = c(tMs / 200);                            // bounce — slight overshoot
    const s = p < 0.6 ? 0.9 + (1.08 - 0.9) * (p / 0.6)
                      : 1.08 - (1.08 - 1) * ((p - 0.6) / 0.4);
    return { scale: s, dy: 0 };
  }

  // Segment clips (per-clip /clips/ files) play 0-based, but the transcript words are stored
  // VOD-absolute. Rebase them by source_start so word timestamps match the clip's currentTime.
  // Idempotent: skips full-VOD clips, and skips data that's already 0-based — so wiring a 0-based
  // RPC later won't double-subtract.
  function _rebaseTranscriptForSegment(words) {
    if (!Array.isArray(words) || !words.length) return words;
    const v = document.querySelector('[wized="stream_clip_video"]');
    if (!/\/clips\//i.test(v?.currentSrc || v?.src || '')) return words;   // full-VOD → already in the video timebase
    const off = parseFloat(document.querySelector('[wized="stream_clip_source_start"]')?.textContent.trim() || '0') * 1000;
    if (!(off > 0) || words[0].start < off) return words;                  // already 0-based / no offset → leave as-is
    return words.map(w => ({ ...w, start: Math.max(0, w.start - off), end: Math.max(0, w.end - off) }));
  }

  // ── Caption keyword emphasis (deterministic, no LLM) ─────────────────────────────────────────────
  // Highlight the clip's topic KEYWORDS + shouted (ALL-CAPS) words wherever they land in the captions —
  // the "money word in colour + bigger" look that drives short-form retention. Defined at LOAD here (core
  // module) so BOTH surfaces have it: the live-preview DOM below and the canvas export in canvas-render,
  // which both call window._capIsEmph. Graceful: absent → captions render exactly as before. Tunable live
  // via window._capEmphCfg = { color, scale }.
  window._capEmphCfg = window._capEmphCfg || { color: '#ffe14d', scale: 1.14 };
  window._capIsEmph = window._capIsEmph || (function () {
    const STOP = new Set(['this','that','with','your','from','they','them','were','have','what','when','then',
      'than','into','just','like','about','really','gonna','their','there','which','would','could','because']);
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    let _set = null, _src = null;
    function kw() {
      const src = document.querySelector('[wized="stream_clip_keywords"]')?.textContent || '';
      if (src === _src && _set) return _set;
      _src = src; _set = new Set();
      try { for (const k of JSON.parse(src || '[]')) for (const tok of String(k).split(/\s+/)) {
        const n = norm(tok); if (n.length >= 4 && !STOP.has(n)) _set.add(n);
      } } catch (_) {}
      return _set;
    }
    return function (text) {
      if (!text) return false;
      const raw = String(text).replace(/[^A-Za-z0-9]/g, '');
      if (raw.length >= 3 && raw === raw.toUpperCase() && /[A-Z]{2}/.test(raw)) return true;   // SHOUTED
      return kw().has(norm(text));                                                              // topic keyword
    };
  })();

  function bindSubtitles(video, transcript, pillEl, textEl) {
    if (!transcript?.length || !textEl) return;
    let lastIdx = -2;

    if (pillEl) pillEl.style.visibility = 'hidden';

    // Sample by SOURCE time (ms). Cut-aware: driven by the engine's current source
    // time when active, so a word only shows while a clip covering it is playing.
    function sample(ms) {
      const idx = transcript.findIndex(w => ms >= w.start && ms < w.end);
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (idx !== -1) {
          textEl.textContent      = transcript[idx].text;
          const emph = !!(window._capIsEmph && window._capIsEmph(transcript[idx].text));   // keyword/shouted → colour
          textEl.style.color      = emph ? (window._capEmphCfg?.color || '#ffe14d') : '';  // '' reverts to the style's CSS colour
          pillEl.style.visibility = '';
          pillEl?.classList.add('is-active');
        } else {
          pillEl.style.visibility = 'hidden';
          pillEl?.classList.remove('is-active');
          if (pillEl) pillEl.style.transform = '';
        }
      }
      // Per-frame entry animation on the active word (preset id read from its class) × emphasis scale pop.
      if (idx !== -1 && pillEl) {
        const styleId = (pillEl.className.match(/style-\d{3}/) || [''])[0];
        const a = _subAnim(styleId, ms - transcript[idx].start);
        const eScale = (window._capIsEmph && window._capIsEmph(transcript[idx].text)) ? (window._capEmphCfg?.scale || 1.14) : 1;
        pillEl.style.transformOrigin = 'center';
        pillEl.style.transform = `translateY(${a.dy}em) scale(${a.scale * eScale})`;
      }
    }

    // Engine active → driven per-frame by the time-layer compositor (source time).
    (window.wcTimeLayers ||= []).push((srcSec) => sample(srcSec * 1000));
    // Fallback (engine off): gpVideo drives it directly.
    video.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) sample(video.currentTime * 1000); });
    video.addEventListener('seeked',     () => { if (!window.wcEngine?.isActive?.()) lastIdx = -2; });
  }
  
  function bindSubtitlesChunk(video, transcript, subHold, pillTemplate, CHUNK_SIZE = 3) {
    if (!transcript?.length || !subHold || !pillTemplate) return;
  
    const chunks = [];
    for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
      chunks.push(transcript.slice(i, i + CHUNK_SIZE));
    }
  
    let lastChunkIdx = -2;
    let lastWordIdx  = -2;
  
    pillTemplate.style.visibility = 'hidden';
    pillTemplate.classList.remove('is-active');
  
    function renderChunk(chunkIdx, activeWordIdx) {
      const chunk = chunks[chunkIdx];
      if (chunkIdx !== lastChunkIdx) {
        pillTemplate.style.position = 'absolute';
        subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => p.remove());
        const frag = document.createDocumentFragment();
        chunk.forEach((word, i) => {
          const pill = pillTemplate.cloneNode(true);
          pill.dataset.chunk     = chunkIdx;
          pill.dataset.wordIndex = i;
          pill.style.visibility  = '';
          pill.style.position    = '';
          pill.classList.remove('is-active');
          const emph = !!(window._capIsEmph && window._capIsEmph(word.text));   // colour-only in chunk mode (matches export)
          const txt = pill.querySelector('.subtitle_text');
          if (txt) { txt.textContent = word.text; if (emph) txt.style.color = (window._capEmphCfg?.color || '#ffe14d'); }
          else pill.textContent = word.text;
          frag.appendChild(pill);
        });
        subHold.appendChild(frag);
        lastChunkIdx = chunkIdx;
      }
      if (activeWordIdx !== lastWordIdx) {
        subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => {
          const on = parseInt(p.dataset.wordIndex) === activeWordIdx;
          p.classList.toggle('is-active', on);
          if (!on) p.style.transform = '';   // clear motion on words that are no longer active
        });
        lastWordIdx = activeWordIdx;
      }
    }
  
    function hideAll() {
      subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => {
        p.style.visibility = 'hidden';
        p.classList.remove('is-active');
      });
      pillTemplate.style.position = '';
      lastWordIdx = -2;
    }
  
    // Sample by SOURCE time (ms) — cut-aware when driven by the engine's source time.
    function sample(ms) {
      let foundChunk = -1, foundWord = -1;
      for (let ci = 0; ci < chunks.length; ci++) {
        for (let wi = 0; wi < chunks[ci].length; wi++) {
          const w = chunks[ci][wi];
          if (ms >= w.start && ms < w.end) { foundChunk = ci; foundWord = wi; break; }
        }
        if (foundChunk !== -1) break;
      }
      if (foundChunk !== -1) {
        renderChunk(foundChunk, foundWord);
        const ap = subHold.querySelector('.subtitle_pill[data-chunk].is-active');
        if (ap) {
          const styleId = (ap.className.match(/style-\d{3}/) || [''])[0];
          const a = _subAnim(styleId, ms - chunks[foundChunk][foundWord].start);
          ap.style.transformOrigin = 'center';
          ap.style.transform = `translateY(${a.dy}em) scale(${a.scale})`;
        }
      } else if (lastChunkIdx !== -2) {
        const chunk     = chunks[lastChunkIdx];
        const firstWord = chunk[0];
        const lastWord  = chunk[chunk.length - 1];
        if (ms >= firstWord.start && ms < lastWord.end) {
          subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => p.classList.remove('is-active'));
          lastWordIdx = -1;
        } else {
          hideAll();
        }
      }
    }

    // Engine active → per-frame via the time-layer compositor; else gpVideo drives.
    (window.wcTimeLayers ||= []).push((srcSec) => sample(srcSec * 1000));
    video.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) sample(video.currentTime * 1000); });
    video.addEventListener('seeked',     () => { if (!window.wcEngine?.isActive?.()) { hideAll(); lastChunkIdx = -2; } });
  }
  
  // Downsample an AudioBuffer to N normalized (0..1) peak buckets for the waveform UI.
  // Max-abs across channels per bucket; normalized so the loudest bucket = 1.
  function _computePeaks(buf, N) {
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const len = chs[0].length, block = Math.max(1, Math.floor(len / N));
    const peaks = new Float32Array(N);
    let pk = 0;
    for (let i = 0; i < N; i++) {
      const s = i * block, e = Math.min(len, s + block);
      let m = 0;
      for (let j = s; j < e; j++) {
        for (let c = 0; c < chs.length; c++) { const v = chs[c][j] < 0 ? -chs[c][j] : chs[c][j]; if (v > m) m = v; }
      }
      peaks[i] = m; if (m > pk) pk = m;
    }
    if (pk > 0) for (let i = 0; i < N; i++) peaks[i] /= pk;
    return peaks;
  }

  // Time-gate a layer's visibility to its track WINDOW (source seconds). The engine pauses/
  // bypasses gpVideo, so its timeupdate never fires while the engine is active — drive it off
  // the time-layer compositor (engine source time) with a gpVideo fallback for engine-off.
  // The window is read via a LIVE getter so trimming the track updates visibility at once.
  function bindTrack(video, el, getWin) {
    if (!el) return;
    // Title/image/subtitle visibility windows are stored in SOURCE time — the timeline ruler is the
    // source/window space and the default window IS the source window (e.g. a VOD clip's 430–471s).
    // So gate by SOURCE time. (Gating by OUTPUT time broke VOD / cut clips where source ≠ output: a
    // 430–471s window no longer matched the small output playhead → title/image vanished.)
    const at = (srcSec) => {
      let t; try { t = getWin(); } catch (_) { return; }   // getter may reference state still in TDZ at bind time
      if (!t) return;
      const on = srcSec >= (t.start ?? 0) && srcSec <= (t.end ?? Infinity);
      el.style.opacity       = on ? '1' : '0';
      el.style.pointerEvents = on ? ''  : 'none';
    };
    (window.wcTimeLayers ||= []).push((srcSec) => at(srcSec));
    video.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) at(video.currentTime); });
    at(video.currentTime || 0);
  }

  // Overlay FX — LIVE preview surface only (render parity lives in canvas-render.js drawCanvasFrame).
  // A full-frame div over .clip_canvas carries the colour flash; a CSS saturate() filter on the frame
  // carries the desaturate. Driven on the engine clock via wcTimeLayers (smooth 60fps) with a gpVideo
  // timeupdate fallback for engine-off, plus an fxChanged re-apply so edits show while paused. Reads
  // window.canvasAPI.fxIntensityAt(ot) — the SAME resolver the render uses, so preview == export.
  function _bindFx(video, frameEl) {
    if (!frameEl) return;
    let flash = frameEl.querySelector(':scope > .fx_flash');
    if (!flash) {
      flash = document.createElement('div');
      flash.className = 'fx_flash';
      Object.assign(flash.style, {
        position: 'absolute', inset: '0', pointerEvents: 'none',
        opacity: '0', zIndex: '1000', mixBlendMode: 'normal',
      });
      frameEl.appendChild(flash);
    }
    // Only WRITE when a value actually changes — when no FX is active this touches the DOM zero
    // times per frame (a per-frame style write would fire a DOM mutation every rAF, which any
    // MutationObserver-based session recorder reacts to).
    let _lastBg = '', _lastOp = '', _lastFil = '';
    const apply = (ot) => {
      const api = window.canvasAPI;
      if (!api?.fxIntensityAt || ot == null) return;
      const fx  = api.fxIntensityAt(ot);
      const bg  = fx.flashColor || 'transparent';
      const op  = fx.flashAlpha > 0 ? String(fx.flashAlpha) : '0';
      const fil = fx.desat > 0 ? `saturate(${(1 - fx.desat).toFixed(3)})` : '';
      if (bg  !== _lastBg)  { flash.style.background = bg;  _lastBg  = bg;  }
      if (op  !== _lastOp)  { flash.style.opacity    = op;  _lastOp  = op;  }
      if (fil !== _lastFil) { frameEl.style.filter   = fil; _lastFil = fil; }
    };
    (window.wcTimeLayers ||= []).push((srcSec, ot) => apply(ot != null ? ot : srcSec));
    // engine-off fallback (cold preview): source time ≈ output time for segment clips.
    video.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) apply(video.currentTime); });
    // Re-apply when cues change while paused — standalone fx (fxChanged) AND sound-tied overlays
    // (soundboardChanged), so dropping/moving a sound shows its flash immediately, not next tick.
    const _reapply = () =>
      apply(window.wcEngine?.isActive?.() ? window.wcEngine.currentOutputTime() : video.currentTime);
    window.addEventListener('fxChanged', _reapply);
    window.addEventListener('soundboardChanged', _reapply);
    apply(0);
  }
  
  function renderTitlePills(titleHold, title) {
    if (!titleHold || !title) return;
    if (!titleHold.clientWidth) return;
  
    const template = titleHold.querySelector('.title_pill');
    if (!template) return;
  
    const holdCs   = getComputedStyle(titleHold);
    const padL     = parseFloat(holdCs.paddingLeft)  || 0;
    const padR     = parseFloat(holdCs.paddingRight) || 0;
    const maxW     = titleHold.clientWidth - padL - padR;
    if (!maxW) return;
  
    const pillCs   = getComputedStyle(template);
    const pillPadL = parseFloat(pillCs.paddingLeft)  || 0;
    const pillPadR = parseFloat(pillCs.paddingRight) || 0;
    const wrapW    = maxW - pillPadL - pillPadR;
  
    const textEl = template.querySelector('.title_text');
    const cs     = textEl ? getComputedStyle(textEl) : null;
    const font   = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : '700 16px sans-serif';
  
    const mCtx = document.createElement('canvas').getContext('2d');
    mCtx.font   = font;
  
    const words = title.split(' ');
    const lines = [];
    let current = '';
  
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (mCtx.measureText(test).width > wrapW && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  
    titleHold.innerHTML = '';
    lines.forEach(line => {
      const pill = template.cloneNode(true);
      const txt  = pill.querySelector('.title_text');
      if (txt) txt.textContent = line;
      else pill.textContent = line;
      titleHold.appendChild(pill);
    });
  }
  
  function bindControls(item, gpVideo) {
    const fmt = s => {
      if (!isFinite(s) || s < 0) s = 0;
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    };
  
    const currentEl  = item.querySelector('#player_current_time');
    const totalEl    = item.querySelector('#player_total_time');
    const trackEl    = item.querySelector('#player_track');
    const progressEl = item.querySelector('#player_progress');
  
    const tick = () => {
      if (currentEl) currentEl.textContent = fmt(gpVideo.currentTime);
      if (totalEl)   totalEl.textContent   = fmt(gpVideo.duration);
      if (progressEl && isFinite(gpVideo.duration) && gpVideo.duration > 0)
        progressEl.style.width = `${(gpVideo.currentTime / gpVideo.duration) * 100}%`;
    };
  
    gpVideo.addEventListener('loadedmetadata', tick);
    gpVideo.addEventListener('timeupdate',     tick);
  
    if (trackEl) {
      let seeking = false;
      const seek = cx => {
        const r   = trackEl.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (cx - r.left) / r.width));
        if (isFinite(gpVideo.duration) && gpVideo.duration > 0)
          gpVideo.currentTime = pct * gpVideo.duration;
      };
      trackEl.addEventListener('pointerdown', e => { seeking = true; trackEl.setPointerCapture(e.pointerId); seek(e.clientX); });
      trackEl.addEventListener('pointermove', e => { if (seeking) seek(e.clientX); });
      trackEl.addEventListener('pointerup',   () => { seeking = false; });
    }
  
    const playBtn = item.querySelector('#play_button');
    if (playBtn) {
      const btn = playBtn.cloneNode(true);
      playBtn.parentNode.replaceChild(btn, playBtn);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const eng = window.wcEngine;
        if (eng?.isActive?.()) {
          if (eng.paused) { eng.play(); btn.classList.add('is-playing'); }
          else { eng.pause(); btn.classList.remove('is-playing'); }
          return;
        }
        gpVideo.paused ? gpVideo.play().catch(() => {}) : gpVideo.pause();
      });
    }
  
    // When the WebCodecs engine owns playback it pauses gpVideo (and its async 'pause' event would
    // otherwise strip is-playing while the engine is actually playing — the play/pause desync). So
    // let the engine drive the button (enable()'s syncBtns + engine play/pause) and skip these.
    const _engOwns = () => !!window.wcEngine?.isActive?.();
    gpVideo.addEventListener('play', () => {
      document.querySelectorAll('[wized="stream_clip_video"]').forEach(v => {
        if (v !== gpVideo) v.pause();
      });
      if (_engOwns()) return;
      item.querySelector('#play_button')?.classList.add('is-playing');
    });
    gpVideo.addEventListener('pause', () => { if (_engOwns()) return; item.querySelector('#play_button')?.classList.remove('is-playing'); });
    gpVideo.addEventListener('ended', () => { if (_engOwns()) return; item.querySelector('#play_button')?.classList.remove('is-playing'); tick(); });
  }
  
  function bindSelection(frame, holds) {
    holds.forEach(hold => {
      if (!hold) return;
      hold.addEventListener('pointerdown', e => {
        e.stopPropagation();
        holds.forEach(h => h?.classList.remove('is-selected'));
        hold.classList.add('is-selected');
        frame.dispatchEvent(new CustomEvent('layerselect', {
          bubbles: true,
          detail: { layer: hold.dataset.layer ?? null }
        }));
      });
    });

    document.addEventListener('pointerdown', e => {
      if (frame.contains(e.target)) return;
      holds.forEach(h => h?.classList.remove('is-selected'));
      frame.dispatchEvent(new CustomEvent('layerselect', { bubbles: true, detail: { layer: null } }));
    });
  }
  
  function initFacecamCanvas(item, gpVideo, fcHold, x1, y1, x2, y2) {
    if (item._fcRafId) { cancelAnimationFrame(item._fcRafId); item._fcRafId = null; }
  
    let fc = fcHold.querySelector('.facecam_canvas');
    if (!fc) {
      fc = document.createElement('canvas');
      fc.className = 'facecam_canvas';
      fc.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;pointer-events:none;';
      fcHold.appendChild(fc);
    }
  
    const ctx = fc.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let lastW = 0, lastH = 0;
  
    function resizeFcCanvas() {
      const w = fcHold.clientWidth, h = fcHold.clientHeight;
      if (!w || !h || (w === lastW && h === lastH)) return;
      lastW = w; lastH = h;
      fc.width  = w * dpr;
      fc.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (gpVideo.readyState >= 2) drawFrame();
    }
  
    new ResizeObserver(resizeFcCanvas).observe(fcHold);
    resizeFcCanvas();
  
    function drawFrame() {
      // When the WebCodecs engine owns playback, gpVideo is paused — crop from the
      // engine's live gameplay canvas instead (same native dimensions, same crop math).
      const eng = window.wcEngine;
      const wc  = eng?.isActive?.();
      const srcEl = wc ? eng.currentFrameCanvas() : gpVideo;
      if (!srcEl) return;
      // During a clip-transition seek gpVideo briefly has no displayable frame: it seeks AND
      // then drops to readyState<2 (HAVE_METADATA) for a moment while the decode pipeline resets,
      // even when the data is fully buffered. Drawing it in that window clears the canvas to blank
      // and flashes. readyState<2 means "no current frame" — hold the last good frame until ready.
      if (!wc && (gpVideo.seeking || gpVideo.readyState < 2)) return;
      const crop = item._crop || { x1, y1, x2, y2 };
      const vw = wc ? srcEl.width  : gpVideo.videoWidth;
      const vh = wc ? srcEl.height : gpVideo.videoHeight;
      const cw = fcHold.clientWidth,  ch = fcHold.clientHeight;
      if (!vw || !vh || !cw || !ch) return;
      const srcX = crop.x1 * vw, srcY = crop.y1 * vh;
      const srcW = (crop.x2 - crop.x1) * vw, srcH = (crop.y2 - crop.y1) * vh;
      const scale = Math.max(cw / srcW, ch / srcH);
      const dw = srcW * scale, dh = srcH * scale;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(srcEl, srcX, srcY, srcW, srcH, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }

    function rafLoop() { drawFrame(); item._fcRafId = requestAnimationFrame(rafLoop); }
    function startLoop() { if (!item._fcRafId) rafLoop(); }
    function stopLoop() {
      if (window.wcEngine?.isActive?.()) return;   // engine is driving playback — keep the facecam live
      if (item._fcRafId) { cancelAnimationFrame(item._fcRafId); item._fcRafId = null; }
      if (gpVideo.readyState >= 2) drawFrame();
    }
    // Let the WebCodecs controller kick the loop when it takes over (gpVideo won't fire 'play').
    // If the engine is ALREADY active (e.g. a facecam added to this clip after enable), kick now.
    (window._wcFacecamLoops ||= []).push(startLoop);
    if (window.wcEngine?.isActive?.()) startLoop();

    if (!gpVideo._fcBound) {
      gpVideo.addEventListener('play',       startLoop);
      gpVideo.addEventListener('pause',      stopLoop);
      gpVideo.addEventListener('ended',      stopLoop);
      gpVideo.addEventListener('seeked',     () => { if (!item._fcRafId) drawFrame(); });
      gpVideo.addEventListener('canplay',    () => { if (!item._fcRafId) drawFrame(); });
      gpVideo.addEventListener('loadeddata', drawFrame);
      gpVideo._fcBound = true;
    }
  
    if (gpVideo.readyState >= 2) drawFrame();
  }

  // Interpolate a keyframed facecam crop ([{t,x1,y1,x2,y2}], t = ABSOLUTE source seconds) at srcSec.
  // Shared by the live preview (_applyReframe) and exposed for the render (window._fcTrackAt).
  function _interpFcTrack(k, t) {
    if (t <= k[0].t) return k[0];
    if (t >= k[k.length - 1].t) return k[k.length - 1];
    for (let i = 1; i < k.length; i++) {
      if (t <= k[i].t) {
        const a = k[i - 1], b = k[i], f = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return { x1: a.x1 + (b.x1 - a.x1) * f, y1: a.y1 + (b.y1 - a.y1) * f,
                 x2: a.x2 + (b.x2 - a.x2) * f, y2: a.y2 + (b.y2 - a.y2) * f };
      }
    }
    return k[k.length - 1];
  }
  window._fcTrackAt = _interpFcTrack;

  // Manual PER-CLIP crop composition: drag the split bottom panel to PAN and wheel to ZOOM which region of
  // the source it shows — committed to the edit clip's `override.facecam` (so different clips can frame
  // different people/cams by hand — the same field the AI sets). Pan + focus-anchored zoom = full Stage 2.
  // The facecam canvas cover-fits `item._crop` every frame (canvas-api initFacecamCanvas) and the render does
  // the same (canvas-render _effCrop → Math.max cover-fit), so resizing the box is preview↔render consistent.
  function bindSplitCropDrag(fcHold, item) {
    if (!fcHold || fcHold._splitDragBound) return;
    fcHold._splitDragBound = true;
    let drag = null;
    let wheelTimer = null;                                        // debounced commit for wheel-zoom
    // The live crop for the CURRENT clip: `item._crop` is (re)seeded by _applyReframe on every clip change to
    // this clip's effective crop (override.facecam ELSE base), and updated live by pan/zoom below — so it is
    // always the working box for whatever clip is on the playhead. Fall back to the committed value if unset.
    const liveCrop = (cid) => (item._crop && isFinite(item._crop.x1)) ? item._crop : window.canvasAPI?.getClipFacecam?.(cid);
    // Move/up live on WINDOW (added on down, removed on up) so the release is caught no matter
    // where the cursor ends up — the panel is small and a pan almost always exits its bounds, so
    // element-scoped pointerup (even with setPointerCapture, which can silently fail) never fired.
    const onMove = (e) => {
      if (!drag) return;
      const cw = drag.cur.x2 - drag.cur.x1, ch = drag.cur.y2 - drag.cur.y1;
      // Drag right → reveal content to the LEFT → shift the crop box left. Proportional to the crop extent.
      let dx = -((e.clientX - drag.startX) / drag.w) * cw;
      let dy = -((e.clientY - drag.startY) / drag.h) * ch;
      dx = Math.max(-drag.cur.x1, Math.min(1 - drag.cur.x2, dx));
      dy = Math.max(-drag.cur.y1, Math.min(1 - drag.cur.y2, dy));
      drag.box = { x1: drag.cur.x1 + dx, y1: drag.cur.y1 + dy, x2: drag.cur.x2 + dx, y2: drag.cur.y2 + dy };
      item._crop = drag.box;                                      // live preview (facecam canvas reads it per frame)
    };
    const end = () => {
      if (!drag) return;
      const d = drag; drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      fcHold.style.cursor = '';
      window.canvasAPI?.setClipFacecam?.(d.cid, d.box);          // commit → per-clip override
    };
    fcHold.addEventListener('pointerdown', (e) => {
      if (!fcHold.classList.contains('is-split')) return;         // only pan the crop in SPLIT
      if (e.target?.dataset?.overlayHandle) return;
      const api = window.canvasAPI;
      const cid = api?.getEditClip?.();
      const cur = cid && liveCrop(cid);                           // seed from the live box (carries an uncommitted zoom)
      if (!cid || !cur) return;
      clearTimeout(wheelTimer);                                   // a pending zoom-commit would fight this drag
      e.preventDefault(); e.stopPropagation();
      const rect = fcHold.getBoundingClientRect();
      drag = { cid, cur: { ...cur }, startX: e.clientX, startY: e.clientY, w: rect.width || 1, h: rect.height || 1, box: { ...cur } };
      fcHold.style.cursor = 'grabbing';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    // Wheel = ZOOM around the crop's own centre (focus), aspect preserved — exactly like the top frame's
    // focus+zoom. Updates item._crop live for instant feedback; commits once the gesture settles (debounced),
    // so we don't re-run setClips on every wheel tick. Needs passive:false to preventDefault the page scroll.
    fcHold.addEventListener('wheel', (e) => {
      if (!fcHold.classList.contains('is-split')) return;
      const api = window.canvasAPI;
      const cid = api?.getEditClip?.();
      const b = cid && liveCrop(cid);
      if (!cid || !b) return;
      e.preventDefault(); e.stopPropagation();
      const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
      const MINB = 0.06;                                          // tightest crop (max zoom-in)
      let f = e.deltaY < 0 ? 0.92 : 1.08;                        // wheel up = zoom in = smaller box
      f = Math.max(f, MINB / bw, MINB / bh);                      // don't shrink either dim below MINB
      f = Math.min(f, 1 / bw, 1 / bh);                            // don't grow either dim past the full frame
      const nbw = bw * f, nbh = bh * f;
      let x1 = cx - nbw / 2, y1 = cy - nbh / 2, x2 = cx + nbw / 2, y2 = cy + nbh / 2;
      if (x1 < 0) { x2 -= x1; x1 = 0; }                           // shift back inside the frame (box ≤ frame here)
      if (y1 < 0) { y2 -= y1; y1 = 0; }
      if (x2 > 1) { x1 -= (x2 - 1); x2 = 1; }
      if (y2 > 1) { y1 -= (y2 - 1); y2 = 1; }
      item._crop = { x1: Math.max(0, x1), y1: Math.max(0, y1), x2, y2 };   // live preview
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => window.canvasAPI?.setClipFacecam?.(cid, item._crop), 260);
    }, { passive: false });
    fcHold.style.touchAction = 'none';
  }

  // Class-B follower videos (.chat_split_video, the chat-overlay video) mirror gpVideo by
  // re-seeking to its currentTime on every transition. A <video> blanks for a moment while it
  // seeks, so each cut flashes the follower. We can't hold a video's last frame the way a canvas
  // does (the facecam canvas just stops redrawing), so we snapshot the follower's current frame
  // into an overlay canvas right before the re-seek and hold that image until the follower repaints.
  function bindFollowerSeekFreeze(follower, gpVideo, opts = {}) {
    if (follower._seekFreezeBound) return;
    follower._seekFreezeBound = true;

    let cover = null;

    function showCover() {
      const parent = follower.parentElement;
      if (!parent || follower.readyState < 2 || !follower.videoWidth) return;
      if (!cover) {
        cover = document.createElement('canvas');
        cover.className = 'follower_freeze';
        cover.style.cssText =
          'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;' +
          'display:block;pointer-events:none;z-index:6;';
        if (opts.blend) cover.style.mixBlendMode = opts.blend;
        parent.appendChild(cover);
      }
      cover.width  = follower.videoWidth;
      cover.height = follower.videoHeight;
      try {
        cover.getContext('2d').drawImage(follower, 0, 0, cover.width, cover.height);
        cover.style.display = 'block';
      } catch (_) { /* snapshot failed (e.g. not yet decodable) — skip cover, no worse than before */ }
    }

    function hideCover() { if (cover) cover.style.display = 'none'; }

    // Expose so engine-driven seeks (chat following the WebCodecs source clock) can show
    // the freeze cover too — the follower's own 'seeked' handler below hides it on repaint.
    follower._freezeCover = showCover;

    gpVideo.addEventListener('seeked', () => {
      // Already aligned (plain split / contiguous play): no re-seek, no blank, nothing to cover.
      if (Math.abs(follower.currentTime - gpVideo.currentTime) < 0.08) return;
      showCover();
      follower.currentTime = gpVideo.currentTime;
    });

    follower.addEventListener('seeked', () => {
      if (typeof follower.requestVideoFrameCallback === 'function') {
        follower.requestVideoFrameCallback(hideCover);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(hideCover));
      }
    });
  }

  const MODES = ['is-full', 'is-split', 'is-overlay'];
  
  function applyPassiveState(item, state) {
    const clipFrame = item.querySelector('.clip_canvas');
    const gpHold    = item.querySelector('.gameplay_hold');
    const fcHold    = item.querySelector('.facecam_hold');
    const titleHold = item.querySelector('.title_hold');
    const subHold   = item.querySelector('.subtitle_hold');
    const imgHold   = item.querySelector('.image_hold');
    const textGroup = item.querySelector('.text_group');
  
    if (state.mode) {
      MODES.forEach(m => {
        clipFrame?.classList.remove(m);
        gpHold?.classList.remove(m);
        fcHold?.classList.remove(m);
      });
      clipFrame?.classList.add(state.mode);
      gpHold?.classList.add(state.mode);
      if (state.mode === 'is-full') {
        if (fcHold) fcHold.style.display = 'none';
      } else {
        fcHold?.classList.add(state.mode);
        if (fcHold) fcHold.style.display = '';
      }
    }
  
    if (state.titleZone || state.subtitleZone) {
      applyTextZones(textGroup, state.titleZone ?? 'top', state.subtitleZone ?? 'bottom');
    }
  
    if (titleHold && state.titleVisible === false) titleHold.style.visibility = 'hidden';
    if (subHold   && state.subtitleVisible === false) subHold.style.visibility = 'hidden';
    // When multi-image CUES exist, the cue binder (bindImageCues) is authoritative for the overlay's
    // visibility + geometry — skip the legacy single-image hide/reposition so it can't re-hide a cue that
    // just showed (this reapply runs on every Wized requestEnd) or snap the overlay to the legacy position.
    const _hasImageCues = (window.canvasAPI?.getImageCues?.().length || 0) > 0;
    if (imgHold   && state.imageVisible === false && !_hasImageCues) imgHold.style.visibility = 'hidden';

    if (imgHold && state.imageScale && state.imageVisible !== false && !_hasImageCues) {
      const fw = clipFrame?.clientWidth ?? 0;
      const fh = clipFrame?.clientHeight ?? 0;
      if (fw && fh) {
        imgHold.style.width    = `${state.imageScale * fw}px`;
        imgHold.style.height   = 'auto';
        imgHold.style.position = 'absolute';
        requestAnimationFrame(() => {
          const hw = imgHold.offsetWidth, hh = imgHold.offsetHeight;
          imgHold.style.left = `${Math.max(0, Math.min(fw - hw, (state.imageX ?? 0.5) * fw - hw / 2))}px`;
          imgHold.style.top  = `${Math.max(0, Math.min(fh - hh, (state.imageY ?? 0.3) * fh - hh / 2))}px`;
          imgHold.style.visibility = '';
        });
      }
    }
  }
  
  function calcDefaultZoom(gpHold, gpVideo) {
    const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
    const vw = gpVideo.videoWidth,  vh = gpVideo.videoHeight;
    if (!hw || !hh || !vw || !vh) return null;
    const coverScale = Math.max(hw / vw, hh / vh);
    const zoomMin    = Math.max(0.2, (hw / vw) / coverScale);
    return zoomMin + (1 - zoomMin) * 0.3;
  }
  
  function applyMode(mode, refs) {
    const { frame, gpHold, gpVideo, fcHold, chatHold, splitHandle,
            hasFacecam, hasChatSplit,
            bindFcDrag, unbindFcDrag, applyGpZoom,
            applySplit, getSplitPct } = refs;
  
    const safeMode = (!hasFacecam && !hasChatSplit && mode === 'is-split') ? 'is-full' : mode;
  
    ['height', 'top'].forEach(prop => {
      gpHold?.style.removeProperty(prop);
      fcHold?.style.removeProperty(prop);
    });
  
    if (safeMode !== 'is-overlay') {
      ['left', 'top', 'width', 'height', 'position', 'cursor'].forEach(prop => {
        fcHold?.style.removeProperty(prop);
      });
      fcHold?.querySelector('[data-overlay-handle]')?.remove();
    }
  
    if (splitHandle) splitHandle.style.display = 'none';
  
    MODES.forEach(m => {
      frame.classList.remove(m);
      gpHold?.classList.remove(m);
      fcHold?.classList.remove(m);
    });
    frame.classList.add(safeMode);
    gpHold?.classList.add(safeMode);
    fcHold?.classList.add(safeMode);
  
    if (safeMode === 'is-split') {
      if (splitHandle) splitHandle.style.display = '';
      applySplit?.(getSplitPct?.() ?? 0.5);
    } else {
      // Non-split: release the overlay placement bar(s) back to their Webflow default.
      frame.querySelectorAll('.kt_overlay_placement_bar').forEach(_bar => {
        _bar.style.removeProperty('top'); _bar.style.removeProperty('transform');
      });
    }

    if (fcHold) {
      const enteringChatSplit = safeMode === 'is-split' && !hasFacecam && hasChatSplit;
      const leavingChatSplit  = safeMode !== 'is-split' && frame._chatSplitActive;
  
      if (enteringChatSplit && !frame._chatSplitActive) {
        frame._chatSplitActive = true;
        fcHold.style.display   = '';
        if (chatHold) {
          frame._chatOverlayWasVisible = chatHold.style.visibility !== 'hidden';
          chatHold.style.visibility = 'hidden';
        }
        if (!fcHold.querySelector('.chat_split_video') && chatHold) {
          const srcVid = chatHold.querySelector('video');
          if (srcVid?.src) {
            const splitVid = document.createElement('video');
            splitVid.className = 'chat_split_video';
            splitVid.src       = srcVid.src;
            splitVid.muted     = true;
            splitVid.preload   = 'auto';
            splitVid.setAttribute('playsinline', '');
            Object.assign(splitVid.style, {
              width: '100%', height: '100%', objectFit: 'cover',
              display: 'block', pointerEvents: 'none',
            });
            fcHold.insertBefore(splitVid, fcHold.firstChild);
            splitVid.currentTime = gpVideo.currentTime;
            splitVid.load();
            gpVideo.addEventListener('play',   () => splitVid.play().catch(() => {}));
            gpVideo.addEventListener('pause',  () => splitVid.pause());
            bindFollowerSeekFreeze(splitVid, gpVideo);
            if (!gpVideo.paused) splitVid.play().catch(() => {});
          }
        }
      } else if (leavingChatSplit) {
        frame._chatSplitActive = false;
        fcHold.querySelector('.chat_split_video')?.remove();
        fcHold.style.display = 'none';
        if (chatHold && frame._chatOverlayWasVisible !== undefined) {
          chatHold.style.visibility = frame._chatOverlayWasVisible ? '' : 'hidden';
          frame._chatOverlayWasVisible = undefined;
        }
      } else {
        fcHold.style.display = (safeMode !== 'is-full' && hasFacecam) ? '' : 'none';
      }
    }
  
    const bgVid    = gpHold?.querySelector('.bg_video');
    const bgCanvas = gpHold?.querySelector('.bg_canvas');           // iOS engine-drawn bg
    const splitHide = safeMode === 'is-split';
    if (bgCanvas) bgCanvas.style.display = splitHide ? 'none' : '';
    // Hide bg_video in split, or whenever the bg canvas is the active background (iOS).
    if (bgVid) bgVid.style.display = (splitHide || bgCanvas) ? 'none' : '';
  
    if (safeMode === 'is-overlay' && hasFacecam) {
      bindFcDrag?.();
    } else {
      unbindFcDrag?.();
    }
  
    frame._currentMode = safeMode;
  
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (safeMode !== 'is-split') return;
        if (gpVideo.videoWidth) {
          applyGpZoom(1);
        } else {
          gpVideo.addEventListener('loadedmetadata', () => applyGpZoom(1), { once: true });
        }
      });
    });
  }
  
  // Cascade / parent-chain inheritance. A clip's effective value for `key` is taken from the
  // nearest clip AT-OR-BEFORE it in timeline (output) order that carries an explicit `override[key]`.
  // So editing a clip makes it the "parent" for everything downstream until the next clip with its
  // own override; resetting that clip lets the range fall through to the next upstream parent.
  // Returns undefined when nothing upstream overrides → caller uses base.
  // NOTE: as of the per-clip model, **only `layout` cascades, and only within a split chain**
  // (see _applyReframe). MODE no longer cascades — it's isolated per clip (own override.mode else
  // base). Tracking is also NOT cascaded — a motion path is keyed to specific source frames.
  function _cascadeOverride(clips, clip, key) {
    if (!clip) return undefined;
    const ordered = (clips || []).slice().sort((a, b) => (a.outputStart || 0) - (b.outputStart || 0));
    const idx = ordered.findIndex(c => c.id === clip.id);
    if (idx < 0) return clip.override ? clip.override[key] : undefined;
    for (let i = idx; i >= 0; i--) {
      const o = ordered[i].override;
      if (o && o[key] !== undefined) return o[key];
    }
    return undefined;
  }

  function buildPanelAPI(refs) {
    const {
      frame, gpHold, gpVideo, fcHold, chatHold,
      titleHold, titleText, subHold, textGroup,
      imgHold, imgEl,
      getGpZoom, applyGpZoom, applyModeFn, getSplitPct,
      tracks, getTrackBounds, clampSecondaryTracks,
      modeStates,
      musicState,
    } = refs;
  
    let imgScale = imgHold?._wfDefaultScale ?? 0.25;
    let imgX     = imgHold?._wfDefaultX ?? 0.5;
    let imgY     = imgHold?._wfDefaultY ?? 0.3;

    let _characters    = [];     // user-built identity library: [{ id, emb:[…], thumb, name, track? }] (track = base cache)
    let _baseCharacter = null;   // active character when editing base (no clip selected) — mirrors override.character
    let _titleStyle    = null;
    let _subtitleStyle = null;
    let _musicOffset   = 0;
    let _musicUrl      = null;
    let _musicBlobUrl  = null;
    let _musicPeaks    = null;   // normalized 0..1 amplitude buckets for the waveform UI
    let _musicVolume   = 0.8;
    let _musicMuted    = false;
    let _soundboard    = [];     // one-shot snippets on the soundboard track: [{ id, url, at, name, buffer, duration }]
    let _images        = [];     // multi-image track cues: [{ id, url, at, dur, x, y, scale, name }] — output-time anchored
    let _fx            = [];     // overlay FX cues: [{ id, preset, at, kind, color, dur, peak }] — see FX_PRESETS
    let _clipVolume    = 1.0;
    let _watermarkVisible = false;
    let _sourceBadgeVisible = true;

    const _musicAudio = document.createElement('audio');
    _musicAudio.preload = 'auto';
    _musicAudio.volume  = _musicVolume;
    // Keep pitch constant when we nudge playbackRate to converge to the engine clock
    // (drift correction below) — so the tempo micro-adjust is inaudible, not a chipmunk.
    _musicAudio.preservesPitch = true;
    _musicAudio.mozPreservesPitch = true;
    _musicAudio.webkitPreservesPitch = true;
    document.body.appendChild(_musicAudio);

    // Route music through a Web Audio GainNode so volume/mute work on iOS, where
    // HTMLMediaElement.volume is read-only/ignored. Lazily created on the engine's
    // (gesture-unlocked) AudioContext when music first plays. element.volume is kept as
    // the desktop fallback. Only route the same-origin BLOB src (the normal path) —
    // a cross-origin raw URL would taint Web Audio to silence, so leave that on direct
    // element playback. createMediaElementSource can only run once per element.
    let _musicGain = null, _musicSrcNode = null;
    function _ensureMusicGain() {
      if (_musicGain) return;
      if (!(_musicAudio.src || '').startsWith('blob:')) return;   // raw/cross-origin → don't route (would silence it)
      const ctx = window.wcEngine?.audioContext?.();
      if (!ctx) return;   // engine/context not up yet — retry on next play / volume change
      try {
        _musicSrcNode = ctx.createMediaElementSource(_musicAudio);
        _musicGain    = ctx.createGain();
        _musicGain.gain.value = _musicMuted ? 0 : _musicVolume;
        _musicSrcNode.connect(_musicGain);
        _musicGain.connect(ctx.destination);
        _musicAudio.volume = 1;   // gain is now the sole control — avoid double-attenuation
      } catch (_) { _musicGain = null; _musicSrcNode = null; }
    }
    const _wmVideoEl = document.querySelector('#watermark_video');
    if (_wmVideoEl) {
      _wmVideoEl.pause();
      _wmVideoEl.addEventListener('play', () => {
        if (gpVideo.paused && !window.wcEngine?.isActive?.()) _wmVideoEl.pause();
      });
    }

    // When the WebCodecs engine owns playback, take the source time + play state
    // from it (gpVideo is paused and no longer authoritative).
    const _wcOn      = () => window.wcEngine?.isActive?.();
    const _curSrcSec = () => _wcOn() ? window.wcEngine.currentSourceTime() : gpVideo.currentTime;
    const _isPlaying = () => _wcOn() ? !window.wcEngine.paused : !gpVideo.paused;

    function _syncMusicToVideo() {
      if (document.querySelector('.clip_canvas')?._rendering) return;
      if (!_musicUrl) return;

      // Music is a continuous bed. The render lays it by OUTPUT frame
      // (mixAudioBuffers: musicFrame = offset + (outFrame - (trackStart - effectiveStart))).
      // So when the engine owns playback, drive music from OUTPUT time, not source —
      // otherwise reorder cuts make the source time jump and the music skips. The
      // legacy (flag-off) path keeps source time, which matches its non-reordered use.
      let pos, trackStart, trackEnd;
      const trackStartAbs = tracks.music.start ?? 0;
      const trackEndAbs   = tracks.music.end   ?? gpVideo.duration;
      if (_wcOn()) {
        const { effectiveStart } = getTrackBounds();
        pos        = window.wcEngine.currentOutputTime();
        trackStart = trackStartAbs - effectiveStart;
        trackEnd   = trackEndAbs   - effectiveStart;
      } else {
        pos = gpVideo.currentTime; trackStart = trackStartAbs; trackEnd = trackEndAbs;
      }

      const inWindow = pos >= trackStart && pos <= trackEnd;
      if (!inWindow || _musicMuted || !_isPlaying()) {
        _musicAudio.pause();
        return;
      }
      const targetTime = _musicOffset + (pos - trackStart);
      const drift      = _musicAudio.currentTime - targetTime;   // signed: + = music is AHEAD of the clock
      const adrift     = Math.abs(drift);
      // The music element runs on its own clock; the engine runs on the AudioContext
      // clock. They drift, and HARD-SEEKING the element on every small drift is what
      // made the bed crackle / pause / restart. Instead converge SMOOTHLY by nudging
      // playbackRate (pitch preserved); only hard-seek on a real jump (scrub / loop).
      if (adrift > 0.75) {
        if (window.WC_MUSIC_DIAG) console.log(`[music] hard seek (jump) ${_musicAudio.currentTime.toFixed(2)}→${targetTime.toFixed(2)} drift=${drift.toFixed(2)}`);
        _musicAudio.currentTime = targetTime;
        _musicAudio.playbackRate = 1;
      } else if (adrift > 0.04) {
        _musicAudio.playbackRate = Math.max(0.94, Math.min(1.06, 1 - drift * 0.5));   // ahead → slow, behind → speed up
      } else if (_musicAudio.playbackRate !== 1) {
        _musicAudio.playbackRate = 1;                                                  // converged → normal speed
      }
      if (_musicAudio.paused) { _ensureMusicGain(); _musicAudio.play().catch(() => {}); }
    }

    gpVideo.addEventListener('play', () => {
      if (document.querySelector('.clip_canvas')?._rendering) return;
      if (!_musicUrl) return;
      const t          = gpVideo.currentTime;
      const trackStart = tracks.music.start ?? 0;
      const trackEnd   = tracks.music.end   ?? gpVideo.duration;
      if (t >= trackStart && t <= trackEnd && !_musicMuted) {
        const targetTime = _musicOffset + (t - trackStart);
        _musicAudio.currentTime = targetTime;
        _ensureMusicGain();
        _musicAudio.play().catch(() => {});
      }
    });

    gpVideo.addEventListener('pause',  () => _musicAudio.pause());
    gpVideo.addEventListener('seeked', () => _syncMusicToVideo());

    // iOS blurred letterbox bg: the engine can't stream its canvas into <video> (black),
    // so draw the engine frame into a small blurred bg canvas. Reuses decoded frames (no
    // second download) and is correct for VOD windows (shows the actual segment, not the
    // file start). Desktop keeps the engine's efficient captureStream bg.
    function _ensureBgCanvas() {
      if (!_IS_IOS || !gpHold || !window.wcEngine?.isActive?.()) return;
      let bgC = gpHold.querySelector('.bg_canvas');
      if (!bgC) {
        bgC = document.createElement('canvas');
        bgC.className = 'bg_canvas';
        Object.assign(bgC.style, {
          position: 'absolute', inset: '0', width: '100%', height: '100%',
          objectFit: 'cover', filter: 'blur(20px)', transform: 'scale(1.1)',
          zIndex: '0', pointerEvents: 'none',
        });
        gpHold.insertBefore(bgC, gpHold.querySelector('.source_embed'));
      }
      const bgv = gpHold.querySelector('.bg_video');
      if (bgv) bgv.style.display = 'none';                                  // replace the black/stream bg
      bgC.style.display = (frame._currentMode === 'is-split') ? 'none' : '';
      if (bgC._raf) return;                                                 // already drawing
      const bctx = bgC.getContext('2d');
      const W = 256;                                                        // tiny → cheap; CSS blurs it anyway
      const draw = () => {
        if (!window.wcEngine?.isActive?.()) { bgC._raf = 0; return; }
        const src = window.wcEngine.currentFrameCanvas?.();
        if (src && src.width) {
          const h = Math.max(1, Math.round(W * src.height / src.width));
          if (bgC.width !== W) bgC.width = W;
          if (bgC.height !== h) bgC.height = h;
          try { bctx.drawImage(src, 0, 0, W, h); } catch (_) {}
        }
        bgC._raf = requestAnimationFrame(draw);
      };
      bgC._raf = requestAnimationFrame(draw);
    }

    // When the WebCodecs engine takes over, adopt the current mixer levels (its gain
    // defaults to 1, so a level set before enable would otherwise be ignored).
    window.addEventListener('wcReady', () => {
      if (window.wcEngine?.isActive?.()) { try { window.wcEngine.setVolume(_clipVolume); } catch (_) {} }
      _ensureMusicGain();
      if (_musicGain) _musicGain.gain.value = _musicMuted ? 0 : _musicVolume;
      _ensureBgCanvas();
    });
    gpVideo.addEventListener('play',  () => { if (_watermarkVisible) document.querySelector('#watermark_video')?.play().catch(() => {}); });
    gpVideo.addEventListener('pause', () => document.querySelector('#watermark_video')?.pause());
    gpVideo.addEventListener('timeupdate', () => {
      if (!gpVideo.paused) _syncMusicToVideo();
    });

    // Chat overlay video (.chat_split_video in split, else the .chat_hold video) is a
    // follower at gpVideo's SOURCE timebase. Its legacy sync hooks fire on gpVideo
    // events — which never fire while the WebCodecs engine owns playback (gpVideo is
    // bypassed) — so under the engine the chat wouldn't track the current segment.
    // Drive it from the engine's source clock: smooth playbackRate convergence WITHIN a
    // clip (no seeks/blank; chat is muted scrolling text so a tempo nudge is invisible),
    // hard-seek only on a cut/reorder jump (honest jump to match the new gameplay moment).
    function _syncChatToEngine() {
      const eng = window.wcEngine;
      if (!eng?.isActive?.()) return;
      const chatVid = document.querySelector('.chat_split_video') || document.querySelector('.chat_hold video');
      if (!chatVid || !chatVid.src || chatVid.readyState < 1) return;
      if (eng.paused) { if (!chatVid.paused) chatVid.pause(); return; }
      let target; try { target = eng.currentSourceTime(); } catch (_) { return; }
      if (!isFinite(target)) return;
      const drift = chatVid.currentTime - target;   // + = chat ahead of the gameplay moment
      const adrift = Math.abs(drift);
      if (adrift > 0.75)       { chatVid._freezeCover?.(); chatVid.currentTime = target; chatVid.playbackRate = 1; }   // cut/reorder jump (cover hides the seek blank)
      else if (adrift > 0.05)  { chatVid.playbackRate = Math.max(0.94, Math.min(1.06, 1 - drift * 0.5)); }
      else if (chatVid.playbackRate !== 1) { chatVid.playbackRate = 1; }
      if (chatVid.paused) chatVid.play().catch(() => {});
    }

    // While the WebCodecs engine owns playback, gpVideo fires no timeupdate/play/pause,
    // so drive music + watermark + chat from here. On handback, let gpVideo's own state take over.
    let _wcWasActive = false;
    setInterval(() => {
      const active = !!window.wcEngine?.isActive?.();
      if (active) {
        _syncMusicToVideo();
        _syncChatToEngine();
        const wm = document.querySelector('#watermark_video');
        if (wm) {
          if (!window.wcEngine.paused && _watermarkVisible) { if (wm.paused) wm.play().catch(() => {}); }
          else if (!wm.paused) wm.pause();
        }
      } else if (_wcWasActive && gpVideo.paused) {   // just handed back, paused → stop extras
        _musicAudio.pause();
        document.querySelector('#watermark_video')?.pause();
        // reset chat rate so gpVideo-driven sync isn't left mid-nudge
        const chatVid = document.querySelector('.chat_split_video') || document.querySelector('.chat_hold video');
        if (chatVid) chatVid.playbackRate = 1;
      }
      _wcWasActive = active;
    }, 100);
  
    function applyImgScale(scale) {
      if (!imgHold) return;
      imgScale = scale;
      imgHold.style.width  = `${scale * frame.clientWidth}px`;
      imgHold.style.height = 'auto';
    }
  
    function applyImgPosition(x, y) {
      if (!imgHold) return;
      imgX = x;
      imgY = y;
      const fw = frame.clientWidth,  fh = frame.clientHeight;
      const hw = imgHold.offsetWidth, hh = imgHold.offsetHeight;
      imgHold.style.left = `${Math.max(0, Math.min(fw - hw, x * fw - hw / 2))}px`;
      imgHold.style.top  = `${Math.max(0, Math.min(fh - hh, y * fh - hh / 2))}px`;
    }
  
    window.canvasAPI = {
      setMode(mode)            { window.setLayoutMode?.(mode); },   // routed setter lives in initCanvas scope; window.setLayoutMode === _setModeRouted (in-scope + safe during restore)
      getMode()                { return frame._currentMode ?? 'is-full'; },
      // Mode the UI should show as active: the SELECTED clip's OWN mode (override.mode), else base.
      // Mode is ISOLATED per clip — no cascade/carry-forward. Editing a clip's mode changes only
      // that clip; a clip with no override.mode shows the base mode (the shared default).
      getEffectiveMode() {
        const id = this.getEditClip();
        if (id) {
          const m = (tracks.video.clips || []).find(c => c.id === id)?.override?.mode;   // this clip's own mode only
          if (m) return m;
        }
        return frame._baseMode || 'is-full';
      },
      // Per-clip mode runs across the timeline, merged: consecutive clips sharing a mode collapse
      // into one block; the run splits wherever the mode changes. Mode is each clip's OWN override
      // (else base) — ISOLATED, no cascade. Output-time keyed so the mode lane lines up under the
      // clip track and follows cuts/reorder/trims. Returns [{ mode, outputStart, outputEnd, clips }].
      getModeSegments() {
        const all = tracks.video.clips || [];
        const ordered = all.slice().sort((a, b) => (a.outputStart || 0) - (b.outputStart || 0));
        const base = frame._baseMode || 'is-full';
        const segs = [];
        for (const c of ordered) {
          const span = c.sourceEnd - c.sourceStart;
          if (!(span > 0)) continue;
          const mode  = c.override?.mode || base;   // this clip's own mode only (no cascade)
          const start = c.outputStart || 0, end = start + span;
          const last  = segs[segs.length - 1];
          if (last && last.mode === mode && Math.abs(last.outputEnd - start) < 0.001) { last.outputEnd = end; last.clips++; }
          else segs.push({ mode, outputStart: start, outputEnd: end, clips: 1 });
        }
        return segs;
      },
      // Split mode only makes sense with a facecam crop OR a chat video — otherwise the top/bottom
      // split has nothing in the bottom half and is identical to fill (applyMode already coerces it
      // to is-full). Used to disable the split button + guard the setter. Re-derived from the source
      // DOM (same data init/applyMode read), so it stays correct regardless of scope.
      canSplit() {
        const hasCrop = document.querySelector('[wized="stream_clip_contains_facecam"]')?.textContent.trim().toLowerCase() === 'true';
        const x1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x1"]')?.textContent);
        const y1 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y1"]')?.textContent);
        const x2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_x2"]')?.textContent);
        const y2 = parseFloat(document.querySelector('[wized="stream_clip_facecam_y2"]')?.textContent);
        const cropValid = hasCrop && [x1, y1, x2, y2].every(isFinite) && x2 > x1 && y2 > y1;
        const hasChat = !!document.querySelector('[wized="stream_clip_chat"]')?.textContent.trim();
        // Supabase is now just the DEFAULT, not the gate: split is also available with an injected base crop
        // (auto-layout / AI facecam) or when ANY clip carries a per-clip `override.facecam` (duo / dynamic cam).
        const injected = !!frame._cropInjected;   // auto-layout / AI base crop (Supabase base = cropValid above)
        const perClip  = (tracks.video.clips || []).some(c => c.override && c.override.facecam);
        return cropValid || hasChat || injected || perClip;
      },
      setTitle(str)            { renderTitlePills(titleHold, str); },
      setTitleVisible(bool)    { if (titleHold) { titleHold._userVisible = bool; titleHold.style.visibility = bool ? '' : 'hidden'; } },
      setTitleZone(zone)       { applyTextZones(textGroup, zone, textGroup?._subZone   ?? 'bottom'); },
      // Title visibility WINDOW in SOURCE time (bindTrack gates the preview, render gates the same tracks.title).
      // end=null → show to the end. Live: bindTrack reads tracks.title each frame, so this updates instantly.
      setTitleTiming(startSrc, endSrc) {
        if (!tracks.title) tracks.title = { start: 0, end: null };
        tracks.title.start = Math.max(0, +startSrc || 0);
        tracks.title.end   = (endSrc == null) ? null : Math.max(tracks.title.start + 0.1, +endSrc);
        window._timelineUpdateFns?.forEach(fn => fn());
      },
      setSubtitleVisible(bool) { if (subHold) subHold.style.visibility = bool ? '' : 'hidden'; },
      setSubtitleZone(zone)    { applyTextZones(textGroup, textGroup?._titleZone ?? 'top', zone); },
      setChatVisible(bool)     {
        if (!chatHold) return;
        // In chat-split the overlay must stay force-hidden (chat shows via .chat_split_video).
        // Record the intent so leaving split restores it — don't un-hide the draggable box.
        if (frame._chatSplitActive) { frame._chatOverlayWasVisible = !!bool; return; }
        chatHold.style.visibility = bool ? '' : 'hidden';
      },
      setChatBlend(mode)       { const vid = chatHold?.querySelector('video'); if (vid) vid.style.mixBlendMode = mode; },
      setImage(url)            { if (imgEl) imgEl.src = url; },
      setImagePosition(x, y)  { applyImgPosition(x, y); },
      setImageScale(scale)     { applyImgScale(scale); },
      setImageVisible(bool)    { if (imgHold) { imgHold._userVisible = bool; imgHold.style.visibility = bool ? '' : 'hidden'; } },
      // Image visibility WINDOW in SOURCE time (mirrors setTitleTiming; bindTrack + render both gate on tracks.image).
      // end=null → show to the end. Live: bindTrack reads tracks.image each frame, so this updates instantly.
      setImageTiming(startSrc, endSrc) {
        if (!tracks.image) tracks.image = { start: 0, end: null };
        tracks.image.start = Math.max(0, +startSrc || 0);
        tracks.image.end   = (endSrc == null) ? null : Math.max(tracks.image.start + 0.1, +endSrc);
        window._timelineUpdateFns?.forEach(fn => fn());
      },
      setFacecamVisible(bool)  { if (fcHold) fcHold.style.display = bool ? '' : 'none'; },
      // Inject a facecam crop (normalized source box {x1,y1,x2,y2}) when Supabase has none — e.g.
      // auto-layout's scan-detected cam. Makes split renderable; persisted via getState.facecamCrop
      // so it survives reload. Pass null to clear (revert). Supabase crops still take precedence.
      setFacecamCrop(box) {
        // Stored on the .clip_canvas (`frame` here / `clipFrame` in reapplyCrop) — the api closure has
        // `frame` but not the clip container `item`, so derive `item` from it for reapplyCrop.
        const it = frame?.closest?.('[data-canvas="interactive"]');
        if (!box) { if (frame) frame._cropInjected = null; if (it) reapplyCrop(it); return; }
        const { x1, y1, x2, y2 } = box;
        if (![x1, y1, x2, y2].every(Number.isFinite) || !(x2 > x1) || !(y2 > y1)) return;
        if (frame) frame._cropInjected = { x1, y1, x2, y2 };
        if (it) reapplyCrop(it);
      },
      // PER-CLIP facecam crop — the split bottom panel for THIS clip (which region/who), overriding the base
      // (Supabase/injected). `_applyReframe` swaps it in on each clip change. This is what makes different
      // cams/people show at different timestamps (drag-set by hand, or set per-segment by the AI). box=null
      // clears the override → the clip falls back to the base. Clamps to a valid, on-frame box.
      setClipFacecam(clipId, box) {
        if (!clipId) return;
        let ov;
        if (box) {
          let { x1, y1, x2, y2 } = box;
          x1 = Math.max(0, Math.min(1, +x1)); y1 = Math.max(0, Math.min(1, +y1));
          x2 = Math.max(0, Math.min(1, +x2)); y2 = Math.max(0, Math.min(1, +y2));
          if (!(x2 - x1 > 0.03) || !(y2 - y1 > 0.03)) return;   // reject a collapsed box
          ov = { x1: +x1.toFixed(4), y1: +y1.toFixed(4), x2: +x2.toFixed(4), y2: +y2.toFixed(4) };
        }
        const clips = (tracks.video.clips || []).map(c => {
          if (c.id !== clipId) return c;
          const override = { ...(c.override || {}) };
          if (ov) override.facecam = ov; else delete override.facecam;
          delete override.facecamTrack;   // a MANUAL box always wins — drop any keyframed follow-track
          return { ...c, override };
        });
        window.canvasAPI?.setClips?.(clips, true);   // merge — keep other overrides (mode/layout/tracking)
        _lastLayoutClipId = null;                     // force _applyReframe to re-resolve the crop next frame
      },
      // Effective facecam crop for a clip id (its override else the base) — for drag start + render read.
      getClipFacecam(clipId) {
        const c = (tracks.video.clips || []).find(x => x.id === clipId);
        const ov = c && c.override && c.override.facecam;
        if (ov && isFinite(ov.x1)) return { ...ov };
        const it = frame?.closest?.('[data-canvas="interactive"]');
        return it?._cropBase ? { ...it._cropBase } : (frame?._cropInjected ? { ...frame._cropInjected } : null);
      },


      setWatermarkVisible(bool) { 
        _watermarkVisible = bool;
        const wm = document.querySelector('#watermark_video');
        if (wm) {
          wm.style.display = bool ? '' : 'none';
          if (bool && !gpVideo.paused) wm.play().catch(() => {});
          else wm.pause();
        }
      },

      setSourceBadgeVisible(bool) {
        _sourceBadgeVisible = bool;
        const badge = document.querySelector('#source_badge');
        if (badge) badge.style.display = bool ? '' : 'none';
      },

      async setMusic(url) {
        _musicUrl = url;
        document.querySelector('[data-track="music"]')?.classList.remove('is-empty');
        try {
          const res  = await fetch(url);
          const blob = await res.blob();
          if (_musicBlobUrl) URL.revokeObjectURL(_musicBlobUrl);
          _musicBlobUrl   = URL.createObjectURL(blob);
          _musicAudio.src = _musicBlobUrl;
          // Decode the same bytes → amplitude peaks for the waveform UI (one-off, async).
          // Reuse the SHARED decode context (_sbDecodeCtx) — do NOT mint a new OfflineAudioContext per
          // add: browsers cap concurrent AudioContexts (~6), and a fresh-context-per-music-track leaks
          // them until `new` throws → peaks stay null → waveform never draws (worse once the soundboard
          // is in use, since it holds a context too). decodeAudioData works fine on the shared context.
          blob.arrayBuffer()
            .then(ab => {
              const ctx = _sbDecodeCtx();
              if (!ctx) return null;
              return ctx.decodeAudioData(ab.slice(0));
            })
            .then(buf => { if (buf) { _musicPeaks = _computePeaks(buf, 2400); window.dispatchEvent(new CustomEvent('musicPeaksReady')); } })
            .catch(err => { console.warn('[music] peaks decode failed', err); });
        } catch (_) {
          _musicBlobUrl   = null;
          _musicAudio.src = url;
        }
        _musicAudio.load();
        _musicAudio.addEventListener('loadedmetadata', () => {
          musicState.duration = _musicAudio.duration;
          window.canvasAPI.setMusicDuration(musicState.duration);
          window._timelineUpdateFns?.forEach(fn => fn());
        }, { once: true });
      },

      getMusicPeaks() { return _musicPeaks; },
      
      setMusicVolume(v) {
        _musicVolume = Math.max(0, Math.min(1, v));
        _ensureMusicGain();
        if (_musicGain) {
          _musicGain.gain.value = _musicMuted ? 0 : _musicVolume;   // routed → gain is the control (iOS-safe)
          _musicAudio.volume = 1;
        } else {
          _musicAudio.volume = _musicVolume;                        // not routed → element volume (desktop)
        }
      },
      
      setMusicMuted(bool) {
        _musicMuted = bool;
        if (_musicGain) _musicGain.gain.value = bool ? 0 : _musicVolume;
        if (bool) _musicAudio.pause();
        else _syncMusicToVideo();
      },

      // Remove the music bed entirely (stop + clear src + mark empty). Lets restore CLEAR music when a snapshot
      // has none — so reverting an AI edit that ADDED music actually removes it (restore only ever set it before).
      clearMusic() {
        _musicUrl = null;
        try { _musicAudio.pause(); } catch (_) {}
        if (_musicBlobUrl) { try { URL.revokeObjectURL(_musicBlobUrl); } catch (_) {} _musicBlobUrl = null; }
        try { _musicAudio.removeAttribute('src'); _musicAudio.load(); } catch (_) {}
        _musicPeaks = null;
        document.querySelector('[data-track="music"]')?.classList.add('is-empty');
        try { window.dispatchEvent(new CustomEvent('musicPeaksReady')); } catch (_) {}
        window._timelineUpdateFns?.forEach(fn => fn());
      },

      setClipVolume(v) {
        _clipVolume = Math.max(0, Math.min(1, v));
        gpVideo.volume = _clipVolume;                                              // fallback (non-engine / desktop)
        if (window.wcEngine?.isActive?.()) window.wcEngine.setVolume(_clipVolume); // engine gain (Web Audio; works on iOS)
      },
  
      setGameplayZoom(z) {
        applyGpZoom(z);
        const mode = frame._currentMode;
        if (mode === 'is-full' || mode === 'is-overlay') {
          const gpLeft = parseFloat(gpVideo.style.left) || 0;
          const gpTop  = parseFloat(gpVideo.style.top)  || 0;
          const gpHW   = gpHold.clientWidth  || 1;
          const gpHH   = gpHold.clientHeight || 1;
          const cL = (gpHW - gpVideo.offsetWidth)  / 2;
          const cT = (gpHH - gpVideo.offsetHeight) / 2;
          modeStates[mode] = { zoom: getGpZoom(), panX: (gpLeft - cL) / gpHW, panY: (gpTop - cT) / gpHH };
        }
      },
      getGameplayZoom() { return getGpZoom(); },
  
      play() {
        if (!gpVideo) return;
        const { effectiveStart } = getTrackBounds();
        if (gpVideo.currentTime < effectiveStart) {
          gpVideo.addEventListener('seeked', () => gpVideo.play().catch(() => {}), { once: true });
          gpVideo.currentTime = effectiveStart;
        } else {
          gpVideo.play().catch(() => {});
        }
      },
      pause()           { gpVideo?.pause(); },
      seekTo(secs)      { if (gpVideo) gpVideo.currentTime = secs; },
      getVideoElement() { return gpVideo; },

  
      setMasterTrim(trimIn, trimOut) {
        const duration = gpVideo?.duration || 0;
        const SNAP     = 0.5;
        if (!duration) {
          tracks.video.trimIn  = trimIn;
          tracks.video.trimOut = trimOut;
          gpVideo.addEventListener('loadedmetadata', () => {
            window.canvasAPI?.setMasterTrim(tracks.video.trimIn, tracks.video.trimOut);
          }, { once: true });
          return;
        }
        const oldStart   = tracks.video.trimIn;
        const oldEnd     = duration - tracks.video.trimOut;
        let safeIn  = Math.max(0, Math.min(trimIn,  duration));
        let safeOut = Math.max(0, Math.min(trimOut, duration - safeIn));
        if (_sourceBounds) {
          safeIn  = Math.max(safeIn,  _sourceBounds.start);
          safeOut = Math.max(safeOut, Math.max(0, duration - _sourceBounds.end));
        }
        if (duration - safeIn - safeOut < 0.5) return;
        const newStart   = safeIn;
        const newEnd     = duration - safeOut;
        const deltaStart = newStart - oldStart;
        const deltaEnd   = newEnd   - oldEnd;
        tracks.video.trimIn  = safeIn;
        tracks.video.trimOut = safeOut;
        Object.keys(tracks).forEach(name => {
          if (name === 'video') return;
          const t          = tracks[name];
          const trackStart = t.start ?? oldStart;
          const trackEnd   = t.end   ?? oldEnd;
          if (Math.abs(trackStart - oldStart) <= SNAP) t.start = trackStart + deltaStart;
          if (t.end !== null && Math.abs(trackEnd - oldEnd) <= SNAP) t.end = trackEnd + deltaEnd;
        });
        clampSecondaryTracks();
        if (tracks.video.cuts?.length) {
          tracks.video.cuts = tracks.video.cuts
            .map(c => ({ start: Math.max(c.start, newStart), end: Math.min(c.end, newEnd) }))
            .filter(c => c.start < newEnd && c.end > newStart)
            .sort((a, b) => a.start - b.start);
        }
      },
  
      setTrack(name, { start, end } = {}) {
        if (!tracks[name]) tracks[name] = { start: 0, end: null };
        const duration = gpVideo?.duration || 0;
        if (!duration) {
          if (start !== undefined) tracks[name].start = start;
          if (end   !== undefined) tracks[name].end   = end;
          return;
        }
        const { effectiveStart, effectiveEnd } = getTrackBounds();
        if (start !== undefined) {
          tracks[name].start = Math.max(effectiveStart, Math.min(start, effectiveEnd));
        }
        if (end !== undefined) {
          tracks[name].end = end === null
            ? null
            : Math.max(tracks[name].start + 0.1, Math.min(end, effectiveEnd));
        }
      
        if (name === 'music') {
          const musicDur = window.canvasAPI?.getMusicDuration() ?? _musicDuration;
          const maxEnd   = tracks.music.start + musicDur;
          if (tracks.music.end === null || tracks.music.end > maxEnd) {
            tracks.music.end = Math.min(effectiveEnd, maxEnd);
          }
        }
      },
  
      getTrackBounds()  { return getTrackBounds(); },
      getSourceWindow() { return _sourceBounds ? { ..._sourceBounds } : null; },
      setSourceWindow(start, end) {
        if (start == null || end == null) { _sourceBounds = null; return; }
        const dur = gpVideo?.duration || 0;
        _sourceBounds = {
          start: Math.max(0, start),
          end:   dur > 0 ? Math.min(dur, end) : end,
        };
      },
      getTracks()      { return JSON.parse(JSON.stringify(tracks)); },
      setCuts(arr)     { tracks.video.cuts = [...(arr || [])].sort((a, b) => a.start - b.start); },
      getCuts()        { return [...(tracks.video.cuts || [])]; },

      getClips()       { return JSON.parse(JSON.stringify(tracks.video.clips || [])); },
      setClips(arr, mergeOverride = true) {
        // Per-clip `override` must survive edits that rebuild bare clips (syncClipsFromBars,
        // ripple). Carry it over by clip id when the incoming clip doesn't already have one.
        // mergeOverride=false is used by resetClipOverride so a cleared override stays cleared.
        const prev = tracks.video.clips || [];
        const byId = mergeOverride ? new Map(prev.map(c => [c.id, c])) : null;
        tracks.video.clips = (arr || []).map(c => {
          if (mergeOverride && c.override === undefined) {
            const o = byId.get(c.id)?.override;
            if (o) return { ...c, override: o };
          }
          return c;
        });
        window.dispatchEvent(new CustomEvent('clipsChanged'));
      },
      // The per-clip EDIT TARGET = the currently-selected clip bar (timeline tags bars with
      // data-clip-id). Derived from the DOM so there's no select/deselect state to keep in sync;
      // null when nothing (or a non-clip track block) is selected → edits go to base.
      // Edit target = the selected clip (ANY clip). Edit the shared BASE by deselecting
      // (click empty timeline) → no selection → edits go to base, which all non-overridden
      // clips inherit. (Dropped the "first clip = base" special case — it made editing a
      // selected clip silently change base, which read as a bug.)
      getEditClip() {
        // A PINNED clip (clicked → .is-selected) wins. Otherwise FOLLOW the playhead, so on-the-fly edits
        // during playback/scrub stick to the clip you're watching instead of being swallowed by the dummy
        // "base". Base (null) only when there are no clips. Deselect (click empty timeline) → back to follow.
        const pinned = document.querySelector('.track-active.is-selected[data-clip-id]')?.dataset.clipId;
        return pinned || this.getPlayheadClipId();
      },
      // The clip under the playhead in OUTPUT time, or null when there are no clips (→ base).
      getPlayheadClipId() {
        const clips = this.getOutputClips();
        if (!clips.length) return null;
        let ot = null;
        try { if (window.wcEngine?.isActive?.()) ot = window.wcEngine.currentOutputTime(); } catch (_) {}
        if (ot == null) return null;
        for (const c of clips) if (ot >= c.outputStart - 1e-3 && ot < c.outputEnd - 1e-3) return c.id;
        const last = clips[clips.length - 1];
        return ot >= last.outputEnd - 1e-3 ? last.id : clips[0].id;   // past end → last clip; before start → first
      },
      // Effective tracking on/off for the edit target (selected clip override, else base).
      isTrackingActive() {
        const id = this.getEditClip();
        if (id) {
          const t = (tracks.video.clips || []).find(c => c.id === id)?.override?.tracking;
          if (t) return !!(t.enabled && t.raw && t.raw.length);
        }
        return !!(window.wcReframe && window.wcReframe.enabled && window.wcReframe.track && window.wcReframe.track.length);
      },
      resetClipOverride(clipId, key) {
        const clips = (tracks.video.clips || []).map(c => {
          if (c.id !== clipId || !c.override) return { ...c };
          if (key) { const o = { ...c.override }; delete o[key]; return { ...c, override: Object.keys(o).length ? o : undefined }; }
          return { ...c, override: undefined };
        });
        this.setClips(clips, false);   // false → don't re-merge the override we just cleared
      },
      // Route a freshly-analysed track to the edit-target clip's override (break away), else
      // to the base reframe. A failed seed (enabled:false) on a clip leaves it inheriting base.
      commitTracking(t) {
        const editClip = this.getEditClip();
        if (editClip) {
          if (t.enabled === false) return;
          const clips = (tracks.video.clips || []).map(c => c.id === editClip
            ? { ...c, override: { ...(c.override || {}), tracking: { enabled: true, seed: t.seed || null, raw: t.raw || [], mode: t.mode || null } } }
            : c);
          this.setClips(clips);
        } else if (window.wcReframe) {
          window.wcReframe.seed = t.seed || null;
          window.wcReframe.mode = t.mode || null;
          window.wcReframe.setTrack(t.raw || []);
          window.wcReframe.enable(t.enabled !== false);
        }
      },
      // ── Character library (user-built identities) ──────────────────────────
      getCharacters() { return _characters.map(c => ({ ...c })); },
      setCharacters(arr) { _characters = (arr || []).map(c => ({ ...c })); window.dispatchEvent(new CustomEvent('charactersChanged')); },
      addCharacter(c) {
        if (!c || !c.emb) return null;
        const id = 'ch_' + Math.random().toString(36).slice(2, 8);
        _characters.push({ id, emb: c.emb.slice(), thumb: c.thumb || '', name: c.name || `Character ${_characters.length + 1}`,
                           sx: c.sx ?? null, sy: c.sy ?? null, atSec: c.atSec ?? null });   // seed = the capture click (re-track without re-clicking)
        window.dispatchEvent(new CustomEvent('charactersChanged'));
        return id;
      },
      removeCharacter(id) {
        _characters = _characters.filter(c => c.id !== id);
        if (_baseCharacter === id) _baseCharacter = null;
        // drop the tag from any clip that referenced it (leaves its baked track alone)
        const clips = (tracks.video.clips || []).map(c => (c.override && c.override.character === id) ? { ...c, override: { ...c.override, character: undefined } } : c);
        this.setClips(clips, false);
        window.dispatchEvent(new CustomEvent('charactersChanged'));
      },
      getCharacter(id) { return _characters.find(c => c.id === id) || null; },
      // Apply an already-computed track to the edit target instantly (no re-analyze) — used to toggle
      // between characters whose tracks are already cached.
      applyTrack(raw, charId) {
        if (!raw || !raw.length) return;
        const editClip = this.getEditClip();
        if (editClip) {
          const clips = (tracks.video.clips || []).map(c => c.id === editClip
            ? { ...c, override: { ...(c.override || {}), tracking: { enabled: true, raw, mode: 'face' }, character: charId } }
            : c);
          this.setClips(clips);
        } else if (window.wcReframe) { window.wcReframe.setTrack(raw); window.wcReframe.enable(true); }
      },
      // ONE cache per character (analyze once per character, EVER). A character's track covers the
      // whole demuxed source, so it's reusable for every clip — there's no per-clip re-analyze and
      // no "base vs clip" bucket split. `ch.track` is the single source of truth (persisted via
      // getState → characters). _applyCharacter routes it to the selected clip's override, or to the
      // base reframe when nothing is selected — both pull the SAME ch.track.
      _applyCharacter(charId, raw, enable) {
        const on = !!(enable && raw && raw.length);
        const editClip = this.getEditClip();
        if (editClip) {
          const clips = (tracks.video.clips || []).map(c => c.id === editClip
            ? { ...c, override: { ...(c.override || {}), tracking: on ? { enabled: true, raw, mode: 'face' } : { enabled: false }, character: on ? charId : undefined } }
            : c);
          this.setClips(clips);
        } else {
          _baseCharacter = on ? charId : null;
          if (window.wcReframe) { window.wcReframe.setTrack(on ? raw : []); window.wcReframe.enable(on); }
        }
      },
      setCharacterTrack(charId, raw) {
        if (raw && raw.length) { const ch = _characters.find(c => c.id === charId); if (ch) ch.track = raw; }   // cache once on the character
        this._applyCharacter(charId, raw, true);
        window.dispatchEvent(new CustomEvent('charactersChanged'));
      },
      selectCharacterTrack(charId) {   // activate the character's cached track instantly; false if not analyzed yet
        const ch = _characters.find(c => c.id === charId);
        if (!ch || !ch.track || !ch.track.length) return false;
        this._applyCharacter(charId, ch.track, true);
        window.dispatchEvent(new CustomEvent('charactersChanged'));
        return true;
      },
      // Wipe a character's analyzed track (keeps the character in the library) + turn it off wherever
      // it's active. Re-analyze needed afterwards.
      clearCharacterTrack(charId) {
        const ch = _characters.find(c => c.id === charId); if (ch) delete ch.track;
        if (_baseCharacter === charId) { _baseCharacter = null; if (window.wcReframe) window.wcReframe.enable(false); }
        const clips = (tracks.video.clips || []).map(c =>
          (c.override && c.override.character === charId)
            ? { ...c, override: { ...c.override, character: undefined, tracking: { enabled: false } } }
            : c);
        this.setClips(clips, false);
        window.dispatchEvent(new CustomEvent('charactersChanged'));
      },
      // Turn tracking OFF for the edit clip (no character; reframe stops panning). Cached charTracks stay.
      setClipTrackingOff() {
        const editClip = this.getEditClip();
        if (!editClip) { _baseCharacter = null; if (window.wcReframe) window.wcReframe.enable(false); window.dispatchEvent(new CustomEvent('charactersChanged')); return; }
        const clips = (tracks.video.clips || []).map(c => c.id === editClip
          ? { ...c, override: { ...(c.override || {}), character: undefined, tracking: { enabled: false } } } : c);
        this.setClips(clips);
        window.dispatchEvent(new CustomEvent('charactersChanged'));
      },
      // Active character + coverage (1 − lost fraction) of the edit clip's current track.
      getClipTrackingInfo() {
        const id = this.getEditClip();
        if (!id) {   // base editing → report the base-active character + its cached-track coverage
          const ch = _baseCharacter ? _characters.find(c => c.id === _baseCharacter) : null;
          const raw = ch && ch.track;
          if (!raw || !raw.length) return { character: _baseCharacter || null, coverage: null };
          let lost = 0; for (const p of raw) if (p && p.lost) lost++;
          return { character: _baseCharacter, coverage: 1 - lost / raw.length };
        }
        const ovr = (tracks.video.clips || []).find(c => c.id === id)?.override;
        const raw = (ovr && ovr.tracking && ovr.tracking.enabled) ? ovr.tracking.raw : null;
        if (!raw || !raw.length) return { character: (ovr && ovr.character) || null, coverage: null };
        let lost = 0; for (const p of raw) if (p && p.lost) lost++;
        return { character: ovr.character || null, coverage: 1 - lost / raw.length };
      },
      // Tag the edit-target clip with the character it's tracking (UI/persistence; the baked track
      // itself is written by commitTracking after the seed-pick analyze).
      setClipCharacterId(charId) {
        const id = this.getEditClip();
        if (!id) return;
        const clips = (tracks.video.clips || []).map(c => c.id === id ? { ...c, override: { ...(c.override || {}), character: charId } } : c);
        this.setClips(clips);
        window.dispatchEvent(new CustomEvent('charactersChanged'));
      },
      getClipCharacterId() {
        const id = this.getEditClip();
        if (!id) return _baseCharacter;   // base editing → the base-active character
        return (tracks.video.clips || []).find(c => c.id === id)?.override?.character || null;
      },
      getOutputDuration() {
        const clips = tracks.video.clips || [];
        if (!clips.length) return 0;
        return clips.reduce((acc, c) => Math.max(acc, c.outputStart + (c.sourceEnd - c.sourceStart)), 0);
      },
      // RULER length — the FIXED editable region the timeline spans: VOD = source
      // window, live = trim region. Stays CONSTANT when clips are deleted, so the
      // freed space becomes dead space at the END (you can expand a clip back into
      // it). This is the visual/scale length used to lay out bars + position the
      // playhead. The separate PLAYABLE extent — getOutputDuration() (sum of clips) —
      // is where playback loops and what the timecode total shows. Two distinct
      // durations on purpose: ruler stays 30s, playback bounces 0..25s.
      getTimelineDuration() {
        if (_sourceBounds) return _sourceBounds.end - _sourceBounds.start;   // VOD window
        const b   = getTrackBounds();
        const len = b.effectiveEnd - b.effectiveStart;                       // live trim region
        if (isFinite(len) && len > 0) return len;
        return this.getOutputDuration();                                     // fallback (no bounds yet)
      },
      getOutputClips() {
        return (tracks.video.clips || [])
          .slice()
          .sort((a, b) => a.outputStart - b.outputStart)
          .map(c => ({ ...c, outputEnd: c.outputStart + (c.sourceEnd - c.sourceStart) }));
      },
      genClipId()      { return `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; },

      getTextLayout() {
        const fh = frame.clientHeight || 1;
        const frameTop = frame.getBoundingClientRect().top;
        const result = {};

        if (titleHold) {
          const r = titleHold.getBoundingClientRect();
          result.titleY      = (r.top - frameTop) / fh;
          result.titleHeight = r.height / fh;
        }
        if (subHold) {
          const r = subHold.getBoundingClientRect();
          result.subY      = (r.top - frameTop) / fh;
          result.subHeight = r.height / fh;
        }

        return result;
      },
  
      setModeStates(states) {
        Object.keys(states).forEach(mode => {
          if (modeStates[mode] !== undefined) {
            modeStates[mode] = { ...modeStates[mode], ...states[mode] };
          }
        });
      },

      setTitleStyle(styleId) {
        _titleStyle = styleId || null;
        const pill = titleHold?.querySelector('.title_pill');
        if (!pill) return;
        pill.classList.forEach(cls => {
          if (/^style-\d{3}$/.test(cls)) pill.classList.remove(cls);
        });
        if (styleId) pill.classList.add(styleId);
        requestAnimationFrame(() => {
          const titleStr = document.querySelector('[wized="stream_clip_title-list"]')?.textContent.trim();
          const inputVal = document.querySelector('[wized="title_text_input"]')?.value;
          renderTitlePills(titleHold, inputVal || titleStr || '');
        });
      },

      setSubtitleStyle(styleId) {
        _subtitleStyle = styleId || null;
        const pill = document.querySelector('.subtitle_pill');
        if (!pill) return;
        pill.classList.forEach(cls => {
          if (/^style-\d{3}$/.test(cls)) pill.classList.remove(cls);
        });
        if (styleId) pill.classList.add(styleId);
        document.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => {
          p.classList.forEach(cls => {
            if (/^style-\d{3}$/.test(cls)) p.classList.remove(cls);
          });
          if (styleId) p.classList.add(styleId);
        });
      },

      setMusicOffset(secs)  { _musicOffset = Math.max(0, secs); },
      getMusicOffset()      { return _musicOffset; },
      setMusicDuration(secs) {
        musicState.duration = Math.max(1, secs);
        if (tracks.music) {
          tracks.music.end = Math.min(
            tracks.music.start + musicState.duration,
            gpVideo?.duration || musicState.duration
          );
        }
      },
      getMusicDuration() { return musicState.duration; },

      // ── Soundboard ───────────────────────────────────────────────────────────
      // One mono channel of one-shot snippets placed at output time. NO overlap: each cue plays until
      // the next one starts (neighbour truncation), so the lane stays visually clean AND only one sound
      // is ever audible at once. Sounds are decoded to AudioBuffers; the engine schedules them (step 2),
      // the timeline draws them (step 3). Both read getSoundboardCues().
      addSoundboardSound(url, at, meta = {}) {
        if (!url) return null;
        const id = 'sb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const entry = { id, url, at: Math.max(0, +at || 0), name: meta.name || '', overlay: meta.overlay || null, buffer: null, duration: 0 };
        _soundboard.push(entry);
        _sbDecode(url)
          .then(buf => { entry.buffer = buf; entry.duration = buf.duration; window.dispatchEvent(new CustomEvent('soundboardChanged')); })
          .catch(e => console.warn('[soundboard] decode failed', url, e?.message || e));
        window.dispatchEvent(new CustomEvent('soundboardChanged'));
        return id;
      },
      removeSoundboardSound(id) {
        const n = _soundboard.length;
        _soundboard = _soundboard.filter(s => s.id !== id);
        if (_soundboard.length !== n) window.dispatchEvent(new CustomEvent('soundboardChanged'));
      },
      moveSoundboardSound(id, at) {
        const s = _soundboard.find(x => x.id === id);
        if (!s) return;
        s.at = Math.max(0, +at || 0);
        window.dispatchEvent(new CustomEvent('soundboardChanged'));
      },
      // Persisted shape (no buffer — re-decoded on restore).
      getSoundboardSounds() { return _soundboard.map(s => ({ id: s.id, url: s.url, at: s.at, name: s.name, overlay: s.overlay || null, duration: s.duration })); },
      async setSoundboardSounds(arr) {
        _soundboard = (arr || []).map(s => ({ id: s.id || ('sb_' + Math.random().toString(36).slice(2, 8)), url: s.url, at: Math.max(0, +s.at || 0), name: s.name || '', overlay: s.overlay || null, buffer: null, duration: 0 }));
        window.dispatchEvent(new CustomEvent('soundboardChanged'));
        await Promise.all(_soundboard.map(e => _sbDecode(e.url).then(b => { e.buffer = b; e.duration = b.duration; }).catch(() => {})));
        window.dispatchEvent(new CustomEvent('soundboardChanged'));
      },
      // Resolved, scheduled cues — the single interface the engine (audio) + timeline (blocks) both read.
      // outputStart = anchor-resolved timeline position; effDur = min(snippet length, gap to next cue).
      // A 'source'-anchored cue whose source moment was cut away resolves to null and drops out.
      getSoundboardCues() {
        const anchorOut = (s) => SOUNDBOARD_ANCHOR === 'source'
          ? (window.canvasAPI?.sourceTimeToOutputTime?.(s.at) ?? null)   // pinned to footage → map source→output (null if cut away)
          : s.at;                                                         // 'output' → stored value IS the timeline position
        const live = _soundboard
          .map(s => ({ s, out: anchorOut(s) }))
          .filter(x => x.out != null && isFinite(x.out))
          .sort((a, b) => a.out - b.out);
        const out = [];
        for (let i = 0; i < live.length; i++) {
          const x = live[i], next = live[i + 1];
          const intrinsic = x.s.duration || (x.s.buffer ? x.s.buffer.duration : 0);
          const gap    = next ? (next.out - x.out) : Infinity;
          const effDur = Math.min(intrinsic, gap);
          if (effDur > SOUNDBOARD_MIN_GAP) {
            out.push({ id: x.s.id, url: x.s.url, name: x.s.name, overlay: x.s.overlay || null, outputStart: x.out, effDur, duration: intrinsic, buffer: x.s.buffer });
          }
        }
        return out;
      },
      getSoundboardGain() { return SOUNDBOARD_GAIN; },
      // Warm the decode cache for a set of urls (the tab's library) so the FIRST placement of each is
      // instant — no decode lag on click. Idempotent (decode is cached per url).
      preloadSoundboard(urls) { (urls || []).forEach(u => { if (u) _sbDecode(u).catch(() => {}); }); },

      // ── Multi-image track (b-roll / meme pop-ups) ───────────────────────────────
      // Output-time-anchored image cues, mirroring the soundboard model (add/move/remove/set + a resolved
      // getImageCues the preview, render and timeline all read). Unlike sounds, images CAN overlap, carry a
      // normalized position/scale, and have an explicit on-screen duration — so there's no neighbour
      // truncation and no audio decode. Every source (upload/library/Tenor/AI) funnels through addImage.
      addImage(url, at, meta = {}) {
        if (!url) return null;
        const id = 'im_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        _images.push({
          id, url,
          at:    Math.max(0, +at || 0),
          dur:   (+meta.dur > 0) ? +meta.dur : IMAGE_DEFAULT_DUR,
          x:     Number.isFinite(+meta.x) ? +meta.x : 0.5,
          y:     Number.isFinite(+meta.y) ? +meta.y : 0.3,
          scale: Number.isFinite(+meta.scale) ? +meta.scale : 0.25,
          name:  meta.name || '',
        });
        window.dispatchEvent(new CustomEvent('imagesChanged'));
        return id;
      },
      removeImage(id) {
        const n = _images.length;
        _images = _images.filter(im => im.id !== id);
        if (_images.length !== n) window.dispatchEvent(new CustomEvent('imagesChanged'));
      },
      moveImage(id, at) {
        const im = _images.find(x => x.id === id);
        if (!im) return;
        im.at = Math.max(0, +at || 0);
        window.dispatchEvent(new CustomEvent('imagesChanged'));
      },
      // Patch a cue's presentation/duration/url — the interactive canvas overlay writes back through here.
      updateImage(id, patch = {}) {
        const im = _images.find(x => x.id === id);
        if (!im) return;
        if (Number.isFinite(+patch.x))     im.x = +patch.x;
        if (Number.isFinite(+patch.y))     im.y = +patch.y;
        if (Number.isFinite(+patch.scale)) im.scale = Math.max(0.02, +patch.scale);
        if (+patch.dur > 0)                im.dur = +patch.dur;
        if (patch.url)                     im.url = patch.url;
        window.dispatchEvent(new CustomEvent('imagesChanged'));
      },
      getImages() { return _images.map(im => ({ id: im.id, url: im.url, at: im.at, dur: im.dur, x: im.x, y: im.y, scale: im.scale, name: im.name || '' })); },
      setImages(arr) {
        _images = (arr || []).map(im => ({
          id:    im.id || ('im_' + Math.random().toString(36).slice(2, 8)),
          url:   im.url,
          at:    Math.max(0, +im.at || 0),
          dur:   (+im.dur > 0) ? +im.dur : IMAGE_DEFAULT_DUR,
          x:     Number.isFinite(+im.x) ? +im.x : 0.5,
          y:     Number.isFinite(+im.y) ? +im.y : 0.3,
          scale: Number.isFinite(+im.scale) ? +im.scale : 0.25,
          name:  im.name || '',
        })).filter(im => im.url);
        window.dispatchEvent(new CustomEvent('imagesChanged'));
      },
      // Resolved cues the preview / render / timeline all read: an output-time window + presentation.
      // NEIGHBOUR TRUNCATION (like getSoundboardCues): images can't overlap — each cue's effDur is capped at the
      // gap to the NEXT cue (and at content end), so a block cuts off where the next begins instead of overlapping.
      // Non-destructive: the stored `dur` is untouched, so moving the next cue away restores the full length.
      getImageCues() {
        const contentEnd = window.canvasAPI?.getOutputDuration?.() ?? Infinity;
        const cap = isFinite(contentEnd) && contentEnd > 0 ? contentEnd : Infinity;
        const live = _images
          .map(im => ({ im, outputStart: Math.max(0, im.at) }))
          .filter(x => x.outputStart < cap)
          .sort((a, b) => a.outputStart - b.outputStart);
        const out = [];
        for (let i = 0; i < live.length; i++) {
          const x = live[i], next = live[i + 1];
          const gap  = next ? (next.outputStart - x.outputStart) : Infinity;   // cut at the next cue's start
          const room = isFinite(cap) ? cap - x.outputStart : Infinity;         // and at content end
          const effDur = Math.max(0.1, Math.min(x.im.dur, gap, room));
          if (effDur > 0.05) {
            out.push({ id: x.im.id, url: x.im.url, name: x.im.name || '', outputStart: x.outputStart, outputEnd: x.outputStart + effDur, effDur, x: x.im.x, y: x.im.y, scale: x.im.scale });
          }
        }
        return out;
      },

      // ── Overlay FX (colour flash / desaturate) ─────────────────────────────────
      // Output-time anchored cues. Usually added automatically beside a soundboard sound
      // (step 4, later), but addFx/removeFx/moveFx also drive them standalone. fxIntensityAt()
      // is the shared resolver the live sampler AND the render both read — see FX_PRESETS.
      addFx(preset, at) {
        const p = FX_PRESETS[preset];
        if (!p) { console.warn('[fx] unknown preset', preset); return null; }
        const id = 'fx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        _fx.push({ id, preset, at: Math.max(0, +at || 0), kind: p.kind, color: p.color, dur: p.dur, peak: p.peak });
        window.dispatchEvent(new CustomEvent('fxChanged'));
        return id;
      },
      removeFx(id) {
        const n = _fx.length;
        _fx = _fx.filter(c => c.id !== id);
        if (_fx.length !== n) window.dispatchEvent(new CustomEvent('fxChanged'));
      },
      moveFx(id, at) {
        const c = _fx.find(x => x.id === id);
        if (!c) return;
        c.at = Math.max(0, +at || 0);
        window.dispatchEvent(new CustomEvent('fxChanged'));
      },
      // Persisted shape — preset name + position only (visual params re-derived from FX_PRESETS on restore).
      getFx() { return _fx.map(c => ({ id: c.id, preset: c.preset, at: c.at })); },
      setFx(arr) {
        _fx = (arr || []).map(c => {
          const p = FX_PRESETS[c.preset];
          return p && { id: c.id || ('fx_' + Math.random().toString(36).slice(2, 8)), preset: c.preset,
                        at: Math.max(0, +c.at || 0), kind: p.kind, color: p.color, dur: p.dur, peak: p.peak };
        }).filter(Boolean);
        window.dispatchEvent(new CustomEvent('fxChanged'));
      },
      getFxList() { return _fx.map(c => ({ id: c.id, preset: c.preset, at: c.at, kind: c.kind, color: c.color, dur: c.dur })); },
      getFxPresets() { return Object.keys(FX_PRESETS); },
      // Composite intensity of every active cue at output time `ot`. Flashes → strongest
      // colour+alpha wins; desaturate → strongest amount wins (the two layer independently).
      // Sources: standalone _fx cues PLUS soundboard sounds carrying an `overlay` preset — the
      // sound's flash is DERIVED from its cue position, so dragging/deleting the sound moves/clears
      // the flash with zero extra bookkeeping. The flash length is the PRESET's dur (independent of
      // how long the snippet plays / its neighbour truncation).
      fxIntensityAt(ot) {
        let flashAlpha = 0, flashColor = null, desat = 0;
        const consider = (kind, color, dur, peak, at) => {
          const e = ot - at;
          if (e <= 0 || e >= dur) return;
          const env = _fxEnv(kind, e, dur);
          if (kind === 'desat') { if (env > desat) desat = env; }
          else { const a = env * peak; if (a > flashAlpha) { flashAlpha = a; flashColor = color; } }
        };
        for (let i = 0; i < _fx.length; i++) {
          const c = _fx[i];
          consider(c.kind, c.color, c.dur, c.peak, c.at);
        }
        const sb = window.canvasAPI?.getSoundboardCues?.() || [];
        for (let i = 0; i < sb.length; i++) {
          const p = sb[i].overlay && FX_PRESETS[sb[i].overlay];
          if (p) consider(p.kind, p.color, p.dur, p.peak, sb[i].outputStart);
        }
        return { flashColor, flashAlpha, desat };
      },


      getState() {
        const fw = frame.clientWidth,  fh = frame.clientHeight;
        const cw       = chatHold?.offsetWidth  ?? 0;
        const ch       = chatHold?.offsetHeight ?? 0;
        const chatLeft = parseFloat(chatHold?.style.left) || 0;
        const chatTop  = parseFloat(chatHold?.style.top)  || 0;
        const fcLeft = parseFloat(fcHold?.style.left) || 0;
        const fcTop  = parseFloat(fcHold?.style.top)  || 0;
        const fcW    = fcHold?.offsetWidth  ?? 0;
        const fcH    = fcHold?.offsetHeight ?? 0;
        const gpLeft = parseFloat(gpVideo?.style.left) || 0;
        const gpTop  = parseFloat(gpVideo?.style.top)  || 0;
        const gpHW   = gpHold?.clientWidth  ?? 1;
        const gpHH   = gpHold?.clientHeight ?? 1;
        return {
          mode:            frame._baseMode ?? frame._currentMode ?? 'is-full',   // BASE mode (the shared default for clips with no override.mode), not the displayed clip's mode — restore sets base; per-clip modes live in clips[].override.mode
          gameplayZoom:    getGpZoom(),
          gameplayPanX:    gpHW ? gpLeft / gpHW : 0,
          gameplayPanY:    gpHH ? gpTop  / gpHH : 0,
          title: Array.from(titleHold?.querySelectorAll('.title_text') ?? [])
            .map(el => el.textContent.trim())
            .join(' ') || document.querySelector('[wized="stream_clip_title-list"]')?.textContent.trim() || '',
          titleZone:       textGroup?._titleZone ?? 'top',
          subtitleZone:    textGroup?._subZone   ?? 'bottom',
          titleVisible:    titleHold ? (titleHold._userVisible !== false) : true,
          subtitleVisible: subHold   ? subHold.style.visibility   !== 'hidden' : true,
          // In chat-split mode the layout force-hides .chat_hold and shows chat via .chat_split_video,
          // so read the stashed user intent instead — otherwise the render thinks chat is off.
          chatVisible:     frame._chatSplitActive
                             ? !!frame._chatOverlayWasVisible
                             : (chatHold ? chatHold.style.visibility !== 'hidden' : true),
          titleStyle:    _titleStyle,
          subtitleStyle: _subtitleStyle,
          titleStart:    tracks.title?.start ?? 0,
          titleEnd:      tracks.title?.end ?? null,
          imageStart:    tracks.image?.start ?? 0,
          imageEnd:      tracks.image?.end ?? null,
          musicOffset:   _musicOffset,
          musicDuration: musicState.duration,
          musicUrl:    _musicUrl,
          musicSrc:    _musicBlobUrl || _musicUrl,
          musicVolume: _musicVolume,
          musicMuted:  _musicMuted,
          clipVolume:  _clipVolume,
          soundboard:  _soundboard.map(s => ({ id: s.id, url: s.url, at: s.at, name: s.name, overlay: s.overlay || null })),
          images:      _images.map(im => ({ id: im.id, url: im.url, at: im.at, dur: im.dur, x: im.x, y: im.y, scale: im.scale, name: im.name || '' })),
          fx:          _fx.map(c => ({ id: c.id, preset: c.preset, at: c.at })),
          facecamCrop: frame?._cropInjected || null,   // scan-injected crop (only set when Supabase had none)
          chatBlend: (() => { const vid = chatHold?.querySelector('video'); return vid ? (vid.style.mixBlendMode || 'screen') : 'screen'; })(),
          imageVisible:   imgHold ? (imgHold._userVisible !== false) : false,
          facecamVisible: fcHold  ? fcHold.style.display !== 'none' : true,
          // When multi-image CUES exist, imgEl.src is a cue's URL (the binder drives it) — don't persist it as the
          // legacy single image, or restore would re-show it (a free-looping GIF) before the NLE is active.
          imgSrc: (_images.length || (imgEl?.getAttribute('src') ?? '').includes('placeholder')) ? '' : (imgEl?.getAttribute('src') ?? ''),
          imageScale: fw && imgHold?.offsetWidth ? imgHold.offsetWidth / fw : imgScale,
          imageX:     fw && imgHold ? (parseFloat(imgHold.style.left || 0) + (imgHold.offsetWidth  / 2)) / fw : imgX,
          imageY:     fh && imgHold ? (parseFloat(imgHold.style.top  || 0) + (imgHold.offsetHeight / 2)) / fh : imgY,
          facecamX:   fw ? (fcLeft + fcW / 2) / fw : 0.06,
          facecamY:   fh ? (fcTop  + fcH / 2) / fh : 0.65,
          facecamW:   fw ? fcW / fw : 0,
          facecamH:   fh ? fcH / fh : 0,
          chatX:      fw ? (chatLeft + cw / 2) / fw : 0.5,
          chatY:      fh ? (chatTop  + ch / 2) / fh : 0.5,
          chatW:      fw ? cw / fw : 0,
          chatH:      fh ? ch / fh : 0,
          splitPct:   getSplitPct?.() ?? 0.5,
          watermarkVisible: _watermarkVisible,
          sourceBadgeVisible: _sourceBadgeVisible,
          playing:    gpVideo ? !gpVideo.paused : false,
          tracks:     JSON.parse(JSON.stringify(tracks)),
          modeStates:   JSON.parse(JSON.stringify(modeStates)),
          sourceBounds: _sourceBounds ? { ..._sourceBounds } : null,
          tracking:   this.getTrackingData(),
          characters: _characters.map(c => ({ ...c })),
        };
      },

      // Auto-reframe track for persistence (canvas_state) + the render tracking_data jsonb.
      // Stores the SEED + the raw (unsmoothed) source-time points; smoothing is re-baked
      // on restore from the baked-in cfg, so the feel stays consistent if defaults change.
      getTrackingData() {
        const rf = window.wcReframe;
        if (!rf || !rf.raw?.length) return null;
        return { enabled: !!rf.enabled, mode: rf.mode || null, seed: rf.seed || null, raw: rf.raw };
      },
      setTracking(t) {
        const rf = window.wcReframe;
        if (!rf || !t || !t.raw?.length) return;
        rf.seed = t.seed || null;
        rf.mode = t.mode || null;
        rf.setTrack(t.raw);
        rf.enable(!!t.enabled);
        window.dispatchEvent(new CustomEvent('trackingChanged'));   // rebuild the lane after restore
      },

    };

    const tlBtn = document.getElementById('timeline_play_button');
    if (tlBtn) {
      tlBtn.addEventListener('click', () => {
        const eng = window.wcEngine;
        if (eng?.isActive?.()) {
          if (eng.paused) { eng.play(); tlBtn.classList.add('is-playing'); }
          else { eng.pause(); tlBtn.classList.remove('is-playing'); }
          return;
        }
        gpVideo.paused ? gpVideo.play().catch(() => {}) : gpVideo.pause();
      });
      // Skip while the engine owns playback — it drives the button via enable()'s syncBtns; otherwise
      // gpVideo's handoff 'pause' would strip is-playing while the engine plays (play/pause desync).
      gpVideo.addEventListener('play',  () => { if (!window.wcEngine?.isActive?.()) tlBtn.classList.add('is-playing'); });
      gpVideo.addEventListener('pause', () => { if (!window.wcEngine?.isActive?.()) tlBtn.classList.remove('is-playing'); });
      gpVideo.addEventListener('ended', () => { if (!window.wcEngine?.isActive?.()) tlBtn.classList.remove('is-playing'); });
    }
  }
  
  function initCanvas(item, opts = {}) {
    const interactive = opts.interactive !== false;
  
    const frame       = item.querySelector('.clip_canvas');
    const gpHold      = item.querySelector('.gameplay_hold');
    const gpVideo     = item.querySelector('[wized="stream_clip_video"]');
    // Don't let gpVideo parallel-download the whole file with preload='auto' — under the WebCodecs
    // engine gpVideo is bypassed, so its full download is pure waste that STARVES the demux (which
    // feeds the engine + filmstrip thumbnails), pushing fresh-clip load to ~30s. Metadata is all it
    // needs. Mirrors the standby buffer's preload fix. (Also set preload="metadata" on the element
    // in Webflow so it applies before Wized binds the src — JS here is the belt-and-suspenders.)
    if (gpVideo && gpVideo.preload !== 'metadata' && gpVideo.preload !== 'none') gpVideo.preload = 'metadata';
    const fcHold      = item.querySelector('.facecam_hold');
    const textGroup   = item.querySelector('.text_group');
    const titleHold   = item.querySelector('.title_hold');
    const titleText   = item.querySelector('.title_text');
    const subHold     = item.querySelector('.subtitle_hold');
    const subPill     = item.querySelector('.subtitle_pill');
    const subText     = item.querySelector('.subtitle_text');
    const imgHold     = item.querySelector('.image_hold');
    const imgEl       = imgHold?.querySelector('img');
    const chatHold    = item.querySelector('.chat_hold');
    const splitHandle = frame?.querySelector('.split_handle');
  
    if (!frame || !gpVideo) return;
  
    let titleResizeTimer = null;
    let _prevFrameW  = frame.clientWidth   || 1;
    let _prevFrameH  = frame.clientHeight  || 1;
    let _prevGpHoldW = gpHold?.clientWidth  || 1;
    let _prevGpHoldH = gpHold?.clientHeight || 1;

    const ro = new ResizeObserver(() => {
      scaleFrame(frame);

      const newW = frame.clientWidth, newH = frame.clientHeight;
      if (newW && newH && (_prevFrameW !== newW || _prevFrameH !== newH)) {
        const rW = newW / _prevFrameW;

        [imgHold, chatHold].forEach(hold => {
          if (!hold || !hold.style.width) return;
          const ow = parseFloat(hold.style.width)  || 0;
          const oh = parseFloat(hold.style.height) || 0;
          const ol = parseFloat(hold.style.left)   || 0;
          const ot = parseFloat(hold.style.top)    || 0;
          hold.style.width = `${ow * rW}px`;
          if (oh) hold.style.height = hold.querySelector('img') ? 'auto' : `${oh * rW}px`;
          hold.style.left  = `${ol * rW}px`;
          hold.style.top   = `${ot * rW}px`;
        });

        if (fcHold && fcHold._overlayPositioned) {
          const ow = fcHold.offsetWidth, oh = fcHold.offsetHeight;
          const ol = parseFloat(fcHold.style.left) || 0;
          const ot = parseFloat(fcHold.style.top)  || 0;
          fcHold.style.width  = `${ow * rW}px`;
          fcHold.style.height = `${oh * rW}px`;
          fcHold.style.left   = `${ol * rW}px`;
          fcHold.style.top    = `${ot * rW}px`;
        }

        if (gpVideo?.videoWidth && gpHold?.clientWidth) {
          const oldGpL = parseFloat(gpVideo.style.left) || 0;
          const oldGpT = parseFloat(gpVideo.style.top)  || 0;
          const oldGpW = gpVideo.offsetWidth  || 0;
          const oldGpH = gpVideo.offsetHeight || 0;

          const panCX = oldGpW > 0 ? (oldGpL + oldGpW / 2) / _prevGpHoldW : 0.5;
          const panCY = oldGpH > 0 ? (oldGpT + oldGpH / 2) / _prevGpHoldH : 0.5;
          const hadPan = oldGpW > _prevGpHoldW &&
            (Math.abs(panCX - 0.5) > 0.005 || Math.abs(panCY - 0.5) > 0.005);

          const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
          const vw = gpVideo.videoWidth,  vh = gpVideo.videoHeight;
          const coverScale = Math.max(hw / vw, hh / vh);
          const mode    = frame._currentMode;
          const zoomMin = mode === 'is-split' ? 1 : Math.max(0.2, (hw / vw) / coverScale);
          gpZoom = Math.min(ZOOM_MAX, Math.max(zoomMin, gpZoom));
          const dw = vw * coverScale * gpZoom;
          const dh = vh * coverScale * gpZoom;

          gpVideo.style.width  = `${dw}px`;
          gpVideo.style.height = `${dh}px`;

          if (hadPan) {
            gpVideo.style.left = dw > hw
              ? `${Math.max(hw - dw, Math.min(0, panCX * hw - dw / 2))}px`
              : `${(hw - dw) / 2}px`;
            gpVideo.style.top = dh > hh
              ? `${Math.max(hh - dh, Math.min(0, panCY * hh - dh / 2))}px`
              : `${(hh - dh) / 2}px`;
          } else {
            gpVideo.style.left = `${(hw - dw) / 2}px`;
            gpVideo.style.top  = `${(hh - dh) / 2}px`;
          }

          _prevGpHoldW = hw;
          _prevGpHoldH = hh;
        }

        _prevFrameW = newW;
        _prevFrameH = newH;
      }

      const titleStr = item.querySelector('[wized="stream_clip_title-list"]')?.textContent.trim();
      if (titleStr) {
        clearTimeout(titleResizeTimer);
        titleResizeTimer = setTimeout(() => {
          item._lastRenderedTitle = null;
          renderTitlePills(titleHold, titleStr);
        }, 50);
      }
    });
    ro.observe(frame.parentElement);
    scaleFrame(frame);
    const getScale = () => frame._canvasScale ?? 1;
  
    if (gpHold) gpHold.style.overflow = 'hidden';
  
    let transcript = null;
    try {
      const raw = wz(item, 'stream_clip_transcript');
      if (raw) {
        transcript = JSON.parse(raw);
        if (!Array.isArray(transcript)) transcript = null;
        else transcript = _rebaseTranscriptForSegment(transcript);
      }
    } catch (_) {}
  
    if (transcript && !item._subtitlesBound) {
      const subMode = subHold?.dataset.subtitleMode ?? 'word';
      if (subMode === 'chunk') {
        bindSubtitlesChunk(gpVideo, transcript, subHold, subPill);
      } else {
        bindSubtitles(gpVideo, transcript, subPill, subText);
      }
      // Share the idempotency flag with reapplyCrop()'s subtitle block (≈line 2041). Without
      // this, reapplyCrop (run by bootCanvas on every Wized requestEnd) binds a SECOND timeupdate
      // listener, and the two bindSubtitlesChunk instances tear down and rebuild each other's
      // pills every tick — flickering the subtitle overlay throughout playback.
      item._subtitlesBound = true;
    }
  
    const cfg = window.editorConfig ?? {};
    bindTrack(gpVideo, titleHold, () => tracks.title);
    // Legacy single-image window — SUPPRESSED when multi-image cues exist (the cue binder below owns the
    // overlay then). Returning null makes bindTrack's gate a no-op, so the two systems never fight.
    bindTrack(gpVideo, imgHold,   () => (window.canvasAPI?.getImageCues?.().length ? null : tracks.image));
    bindTrack(gpVideo, subHold,   () => tracks.subtitle || cfg.subtitleTrack);
    _bindFx(gpVideo, frame);   // overlay FX live preview (colour flash + desaturate)

    // ── Multi-image track — live preview ────────────────────────────────────────
    // The SELECTED (or, absent a selection, the topmost active) cue drives the single .image_hold overlay:
    // one interactive overlay = the active cue's editor (drag/resize writes back via updateImage), while the
    // render draws ALL cues. Output-time anchored (like FX), driven on the engine clock via wcTimeLayers with
    // a gpVideo fallback + an imagesChanged re-apply so adds/edits show while paused. When there are no cues,
    // this stays inert and the legacy single-image bindTrack above owns the overlay.
    (function bindImageCues() {
      if (!imgHold || !imgEl) return;
      let _shownId = null;
      const pick = (ot) => {
        const cues = window.canvasAPI?.getImageCues?.() || [];
        if (!cues.length || ot == null) return { cues, cue: null };
        const active = cues.filter(c => ot >= c.outputStart && ot < c.outputEnd);
        if (!active.length) return { cues, cue: null };
        const sel = window._selectedImageId;
        return { cues, cue: active.find(c => c.id === sel) || active[active.length - 1] };   // sorted by start → last = topmost
      };
      // Position/scale the overlay for a cue. applyImgScale/applyImgPosition live in a DIFFERENT closure
      // (the panel-API builder) and aren't visible here, so replicate their math inline against frame+imgHold
      // (both are in this scope — see _bindFx(gpVideo, frame) above). scale = fraction of frame width; x/y = centre.
      const setGeom = (scale, x, y) => {
        if (!frame) return;
        const fw = frame.clientWidth, fh = frame.clientHeight;
        if (!fw || !fh) return;
        imgHold.style.position = 'absolute';
        imgHold.style.width    = `${scale * fw}px`;
        imgHold.style.height   = 'auto';                     // box comes from imgEl (kept in-flow even for GIFs)
        const hw = imgHold.offsetWidth, hh = imgHold.offsetHeight;
        imgHold.style.left = `${Math.max(0, Math.min(fw - hw, x * fw - hw / 2))}px`;
        imgHold.style.top  = `${Math.max(0, Math.min(fh - hh, y * fh - hh / 2))}px`;
      };
      // Lazy <canvas> for animated GIF/WebP cues — drawn per tick off the engine clock, so pause/scrub/loop
      // match the render. pointerEvents:none so the overlay's drag/resize handles stay clickable through it.
      let _gifCv = null, _gifCtx = null;
      const gifCanvas = () => {
        if (_gifCv) return _gifCv;
        _gifCv = document.createElement('canvas');
        _gifCv.className = 'image_gif_canvas';
        Object.assign(_gifCv.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'none', pointerEvents: 'none' });
        imgHold.insertBefore(_gifCv, imgHold.firstChild);   // first child → paints UNDER the resize handles (they stay visible)
        _gifCtx = _gifCv.getContext('2d');
        return _gifCv;
      };
      const hide = (relinquish) => {
        imgHold.style.opacity = '0'; imgHold.style.visibility = 'hidden';
        if (_gifCv) _gifCv.style.display = 'none';
        imgEl.style.visibility = '';                          // restore for the next static cue
        if (relinquish) imgHold._userVisible = false;
        _shownId = null; imgHold._activeCueId = null;
      };
      const apply = (ot) => {
        // Image cues are OUTPUT-time anchored — only meaningful once the engine/NLE owns playback. Before that
        // (cold load, raw gpVideo playback that fires timeupdate), FORCE-HIDE the overlay when cues exist: a
        // legacy/restore path may have left a stale image or GIF visible + free-looping (the native <img>). Don't
        // place cues by source time. No cues → leave the legacy single-image path alone. isActive stays true when
        // the engine is merely paused, so paused-with-cues still renders correctly.
        if (!window.wcEngine?.isActive?.()) {
          // _images lives in a different closure — use the public getter (getImages) here.
          const nImgs = window.canvasAPI?.getImages?.().length || 0;
          if (nImgs && (_shownId !== null || imgHold.style.visibility !== 'hidden')) {
            imgHold.style.opacity = '0'; imgHold.style.visibility = 'hidden';
            if (_gifCv) _gifCv.style.display = 'none';
            _shownId = null; imgHold._activeCueId = null;
          }
          return;
        }
        const { cues, cue } = pick(ot);
        if (!cues.length) { if (_shownId !== null) hide(true);  return; }   // none left → relinquish to legacy path
        if (!cue)         { if (_shownId !== null) hide(false); return; }   // between cues → hide
        // Set tracking + visibility FIRST — these can't throw, so hide/swap stays correct even if the geometry
        // helper below throws (wcTimeLayers wraps each layer in a silent try/catch).
        _shownId = cue.id;
        imgHold._activeCueId = cue.id;
        imgHold._userVisible = true;
        if (imgEl.getAttribute('src') !== cue.url) imgEl.src = cue.url;    // keep for aspect + getState.imgSrc
        imgHold.style.opacity = '1';
        imgHold.style.visibility = '';
        if (!imgHold._imgDragging) setGeom(cue.scale, cue.x, cue.y);       // drag owns the DOM mid-gesture

        // Animated GIF/WebP → draw the sampled frame into the overlay canvas (loops); else show the <img>.
        if (window.wcGif?.supported && window.wcGif.isGifUrl(cue.url)) {
          window.wcGif.ensure(cue.url);                       // fire-and-forget decode (cached); frames arrive async
          imgEl.style.visibility = 'hidden';                 // hide native <img> (keeps its box → no free-loop)
          const cv = gifCanvas(); cv.style.display = '';
          const bmp = window.wcGif.frameAt(cue.url, ot - cue.outputStart);
          if (bmp) {
            if (cv.width  !== bmp.width)  cv.width  = bmp.width;
            if (cv.height !== bmp.height) cv.height = bmp.height;
            _gifCtx.clearRect(0, 0, cv.width, cv.height);
            _gifCtx.drawImage(bmp, 0, 0);
          }
        } else {
          if (_gifCv) _gifCv.style.display = 'none';
          imgEl.style.visibility = '';
        }
      };
      (window.wcTimeLayers ||= []).push((srcSec, ot) => apply(ot != null ? ot : srcSec));
      gpVideo.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) apply(gpVideo.currentTime); });
      window.addEventListener('imagesChanged', () => {
        const ot = window.wcEngine?.isActive?.() ? window.wcEngine.currentOutputTime() : gpVideo.currentTime;
        apply(ot);
      });
      // Commit a drag/resize of the overlay back to the ACTIVE cue (same px→normalized math getState uses).
      const commit = () => {
        const id = imgHold._activeCueId;
        if (!id || !(window.canvasAPI?.getImageCues?.().length)) return;
        const fw = frame.clientWidth, fh = frame.clientHeight;
        if (!fw || !fh || !imgHold.offsetWidth) return;
        const scale = imgHold.offsetWidth / fw;
        const x = (parseFloat(imgHold.style.left || 0) + imgHold.offsetWidth  / 2) / fw;
        const y = (parseFloat(imgHold.style.top  || 0) + imgHold.offsetHeight / 2) / fh;
        window.canvasAPI.updateImage?.(id, { x, y, scale });
      };
      imgHold.addEventListener('pointerdown', () => { imgHold._imgDragging = true; }, true);   // capture → beats the overlay's stopPropagation
      window.addEventListener('pointerup',   () => { if (imgHold._imgDragging) { imgHold._imgDragging = false; commit(); } });
    })();

    if (cfg.imageOverlay?.url && imgEl) imgEl.src = cfg.imageOverlay.url;
    if (imgHold) {
      const imgDefaults = captureOverlayDefaults(imgHold, frame, getScale);
      if (imgDefaults) {
        imgHold._wfDefaultScale = imgDefaults.scale;
        imgHold._wfDefaultX = imgDefaults.x;
        imgHold._wfDefaultY = imgDefaults.y;
        imgHold.dataset.minWidth = `${imgDefaults.minWidth}`;
        imgHold.dataset.minHeight = `${imgDefaults.minHeight}`;
      }
      imgHold.style.visibility = 'hidden';
      imgHold.style.position   = 'absolute';
    }
  
    bindControls(item, gpVideo);
    requestAnimationFrame(() => applyTextZones(textGroup, 'top', 'bottom'));
  
    if (!interactive) {
      MODES.forEach(m => {
        frame.classList.remove(m);
        gpHold?.classList.remove(m);
        fcHold?.classList.remove(m);
      });
      frame.classList.add('is-full');
      gpHold?.classList.add('is-full');
      if (fcHold) fcHold.style.display = 'none';
      const sourceEmbed = gpHold?.querySelector('.source_embed');
      if (sourceEmbed) Object.assign(sourceEmbed.style, { width: '100%', height: '100%' });
      gpVideo.style.setProperty('object-fit', 'cover', 'important');
      gpVideo.style.position = '';
      return;
    }
  
    frame.classList.add('is-interactive');
  
    const modeStates = {
      'is-full':    { zoom: null, panX: null, panY: null },
      'is-split':   {},
      'is-overlay': { zoom: null, panX: null, panY: null },
    };
  
    let gpZoom = 1;
  
    function applyGpZoom(zoom) {
      const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
      const vw = gpVideo.videoWidth  || hw;
      const vh = gpVideo.videoHeight || hh;
      if (!hw || !hh) return;
  
      const coverScale = Math.max(hw / vw, hh / vh);
      const zoomMin    = frame._currentMode === 'is-split'
        ? 1
        : Math.max(0.2, (hw / vw) / coverScale);
  
      gpZoom = Math.min(ZOOM_MAX, Math.max(zoomMin, parseFloat(zoom.toFixed(3))));
      const dw = vw * coverScale * gpZoom;
      const dh = vh * coverScale * gpZoom;
  
      const oldDw   = gpVideo.offsetWidth  || 0;
      const oldDh   = gpVideo.offsetHeight || 0;
      const curLeft = parseFloat(gpVideo.style.left) || 0;
      const curTop  = parseFloat(gpVideo.style.top)  || 0;
  
      let cx, cy;
      const eps    = 0.5;
      const hasPan = dw > hw && (
        Math.abs(curLeft - (hw - dw) / 2) > eps ||
        Math.abs(curTop  - (hh - dh) / 2) > eps
      );
  
      if (oldDw > 0 && hasPan && gpVideo._hasBeenZoomed) {
        const panCX = (curLeft + oldDw / 2) / hw;
        const panCY = (curTop  + oldDh / 2) / hh;
        cx = dw >= hw ? Math.max(hw - dw, Math.min(0, panCX * hw - dw / 2)) : (hw - dw) / 2;
        cy = dh >= hh ? Math.max(hh - dh, Math.min(0, panCY * hh - dh / 2)) : (hh - dh) / 2;
      } else {
        cx = (hw - dw) / 2;
        cy = (hh - dh) / 2;
      }
  
      gpVideo.style.width  = `${dw}px`;
      gpVideo.style.height = `${dh}px`;
      gpVideo.style.left   = `${cx}px`;
      gpVideo.style.top    = `${cy}px`;
      gpVideo._hasBeenZoomed = true;
    }
  
    function restoreModeZoomPan(mode) {
      const saved = modeStates[mode];
      if (!saved?.zoom) return false;
    
      const doRestore = () => {
        const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
        const vw = gpVideo.videoWidth,  vh = gpVideo.videoHeight;
        if (!vw || !vh || !hw || !hh) return;
    
        const coverScale = Math.max(hw / vw, hh / vh);
        const zoomMin    = Math.max(0.2, (hw / vw) / coverScale);
        gpZoom = Math.min(ZOOM_MAX, Math.max(zoomMin, saved.zoom));
    
        const dw = vw * coverScale * gpZoom;
        const dh = vh * coverScale * gpZoom;
        const centeredL = (hw - dw) / 2;
        const centeredT = (hh - dh) / 2;

        gpVideo.style.width  = `${dw}px`;
        gpVideo.style.height = `${dh}px`;
        gpVideo.style.left = dw <= hw
          ? `${centeredL}px`
          : `${Math.max(hw - dw, Math.min(0, centeredL + saved.panX * hw))}px`;
        gpVideo.style.top  = dh <= hh
          ? `${centeredT}px`
          : `${Math.max(hh - dh, Math.min(0, centeredT + saved.panY * hh))}px`;
      };
    
      if (gpVideo.videoWidth) doRestore();
      else gpVideo.addEventListener('loadedmetadata', doRestore, { once: true });
      return true;
    }

    // ── Per-clip layout ────────────────────────────────────────────────────────
    // Apply a layout {zoom,panX,panY} to gpVideo (same math as restoreModeZoomPan/drag).
    function applyLayout(L) {
      if (!L) return;
      applyGpZoom(typeof L.zoom === 'number' ? L.zoom : gpZoom);
      const hw = gpHold.clientWidth, hh = gpHold.clientHeight;
      const dw = gpVideo.offsetWidth, dh = gpVideo.offsetHeight;
      if (!hw || !dw) return;
      const cL = (hw - dw) / 2, cT = (hh - dh) / 2;
      // FOCUS layout (preferred for programmatic / AI edits): centre a normalized SOURCE point
      // (focusX/focusY, 0..1 in the source frame) on screen using the live zoomed dims — the same
      // centring math the reframe sampler uses. This sidesteps the panX/panY coordinate, which is
      // zoom-dependent + hard-clamped and produces edge-pinned artifacts when emitted blind (e.g.
      // the panX:3.65 values a manual drag leaves behind). Falls back to raw panX/panY when absent,
      // so existing hand-edited clips are unaffected.
      if (typeof L.focusX === 'number' || typeof L.focusY === 'number') {
        const fx = typeof L.focusX === 'number' ? L.focusX : 0.5;
        const fy = typeof L.focusY === 'number' ? L.focusY : 0.5;
        gpVideo.style.left = dw > hw ? `${Math.max(hw - dw, Math.min(0, hw / 2 - fx * dw))}px` : `${cL}px`;
        gpVideo.style.top  = dh > hh ? `${Math.max(hh - dh, Math.min(0, hh / 2 - fy * dh))}px` : `${cT}px`;
        return;
      }
      const px = typeof L.panX === 'number' ? L.panX : 0;
      const py = typeof L.panY === 'number' ? L.panY : 0;
      gpVideo.style.left = dw > hw ? `${Math.max(hw - dw, Math.min(0, cL + px * hw))}px` : `${cL}px`;
      gpVideo.style.top  = dh > hh ? `${Math.max(hh - dh, Math.min(0, cT + py * hh))}px` : `${cT}px`;
    }
    // Write a layout to the edit-target clip's override (break away from base).
    function _setClipLayout(clipId, layout) {
      const api = window.canvasAPI; if (!api) return;
      const clips = api.getClips().map(c => c.id === clipId ? { ...c, override: { ...(c.override || {}), layout } } : c);
      api.setClips(clips);
    }
    // Commit the current gpVideo geometry → edit-target clip override, else base modeStates.
    function _commitLayout() {
      const mode   = frame._currentMode;
      const gpLeft = parseFloat(gpVideo.style.left) || 0, gpTop = parseFloat(gpVideo.style.top) || 0;
      const gpHW   = gpHold.clientWidth || 1, gpHH = gpHold.clientHeight || 1;
      const cL = (gpHW - gpVideo.offsetWidth) / 2, cT = (gpHH - gpVideo.offsetHeight) / 2;
      const panX = (gpLeft - cL) / gpHW, panY = (gpTop - cT) / gpHH;
      const editClip = window.canvasAPI?.getEditClip?.();
      if (editClip) { _setClipLayout(editClip, { zoom: gpZoom, panX, panY }); return; }
      if (mode === 'is-full' || mode === 'is-overlay') modeStates[mode] = { zoom: gpZoom, panX, panY };
      else if (mode === 'is-split') modeStates['is-split'] = { ...modeStates['is-split'], panX, panY };
    }
    let _lastLayoutClipId = '__init__';   // tracks engine clip changes to re-apply per-clip layout
    let _lastLayoutWasOverride = false;   // only touch geometry on boundaries when an override is involved

    if (gpHold && gpVideo) {
      gpVideo.style.position = 'absolute';
  
      Object.assign(gpVideo.style, { width: '100%', height: '100%', left: '0', top: '0' });
      gpVideo.style.setProperty('object-fit', 'cover', 'important');
  
      function createBgVideo() {
        if (_IS_IOS) return;   // iOS uses the engine-drawn .bg_canvas (captureStream→<video> is black)
        if (gpHold.querySelector('.bg_video') || !gpVideo.src) return;
        const bg = document.createElement('video');
        bg.className = 'bg_video';
        bg.src       = gpVideo.src;
        bg.muted     = true;
        bg.setAttribute('playsinline', '');
        Object.assign(bg.style, {
          position: 'absolute', inset: '0',
          width: '100%', height: '100%',
          objectFit: 'cover', filter: 'blur(20px)',
          transform: 'scale(1.1)', zIndex: '0',
          pointerEvents: 'none',
        });
        const sourceEmbed = gpHold.querySelector('.source_embed');
        gpHold.insertBefore(bg, sourceEmbed);

        if (typeof gpVideo.captureStream === 'function') {
          bg.srcObject = gpVideo.captureStream();
          bg.play().catch(() => {});
        } else {
          bg.src     = gpVideo.src;
          bg.preload = 'auto';
          bg.currentTime = gpVideo.currentTime;
          if (!gpVideo.paused) bg.play().catch(() => {});
          gpVideo.addEventListener('play',   () => bg.play().catch(() => {}));
          gpVideo.addEventListener('pause',  () => bg.pause());
          gpVideo.addEventListener('seeked', () => { bg.currentTime = gpVideo.currentTime; });
        }
      }
  
      gpVideo.addEventListener('loadedmetadata', () => {
          createBgVideo();
          gpVideo.style.removeProperty('object-fit');
          gpVideo.style.removeProperty('width');
          gpVideo.style.removeProperty('height');
          gpVideo.style.removeProperty('left');
          gpVideo.style.removeProperty('top');
  
        const mode  = frame._currentMode ?? 'is-full';
        const saved = modeStates[mode];
  
        if (saved?.zoom) {
          gpZoom = saved.zoom;
          applyGpZoom(saved.zoom);
          const gpW  = gpVideo.offsetWidth;
          const gpH  = gpVideo.offsetHeight;
          const gpHW = gpHold.clientWidth;
          const gpHH = gpHold.clientHeight;
          if (gpW && gpH) {
              const cL = (gpHW - gpW) / 2;
              const cT = (gpHH - gpH) / 2;
              gpVideo.style.left = gpW <= gpHW
              ? `${(gpHW - gpW) / 2}px`
              : `${Math.max(gpHW - gpW, Math.min(0, cL + saved.panX * gpHW))}px`;
            gpVideo.style.top  = gpH <= gpHH
              ? `${(gpHH - gpH) / 2}px`
              : `${Math.max(gpHH - gpH, Math.min(0, cT + saved.panY * gpHH))}px`;
          }
        } else if (mode !== 'is-split') {
          gpVideo._hasBeenZoomed = false;
          const defaultZoom = calcDefaultZoom(gpHold, gpVideo);
          if (defaultZoom !== null) applyGpZoom(defaultZoom);
        } else {
          gpVideo._hasBeenZoomed = false;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            applyGpZoom(1);
            const sp = modeStates['is-split'];
            if (sp?.panX !== undefined && sp?.panX !== null) {
              const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
              const dw = gpVideo.offsetWidth, dh = gpVideo.offsetHeight;
              const cL = (hw - dw) / 2, cT = (hh - dh) / 2;
              gpVideo.style.left = dw > hw ? `${Math.max(hw - dw, Math.min(0, cL + sp.panX * hw))}px` : `${cL}px`;
              gpVideo.style.top  = dh > hh ? `${Math.max(hh - dh, Math.min(0, cT + sp.panY * hh))}px` : `${cT}px`;
            }
          }));
        }
  
        const { effectiveStart } = getTrackBounds();
        if (effectiveStart > 0) gpVideo.currentTime = effectiveStart;
      });
  
      if (gpVideo.readyState >= 1) createBgVideo();
  
      makeDraggable(gpHold, {
        target: gpVideo,
        getScale,
        // Two-finger pinch → gameplay zoom (mobile equivalent of the desktop wheel).
        onPinch: (ratio) => {
          applyGpZoom(gpZoom * ratio);
          window.canvasAPI?.setGameplayZoom(gpZoom);
        },
        clamp: (x, y) => {
          const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
          const dw = gpVideo.offsetWidth, dh = gpVideo.offsetHeight;
          const cx = dw <= hw ? (hw - dw) / 2 : Math.max(hw - dw, Math.min(0, x));
          const cy = dh <= hh ? (hh - dh) / 2 : Math.max(hh - dh, Math.min(0, y));
          return [cx, cy];
        },
        onEnd: () => { _commitLayout(); },   // → edit-target clip override, else base modeStates
      });

      gpHold.addEventListener('wheel', e => {
        e.preventDefault();
        const newZoom = gpZoom + (e.deltaY > 0 ? -1 : 1) * ZOOM_STEP;
        applyGpZoom(newZoom);
        _commitLayout();
      }, { passive: false });

      // ── Auto-reframe (motion tracker) ─────────────────────────────────────────
      // A source-time face track drives the gameplay PAN each engine frame, so the
      // 9:16 window follows the subject. Track is stored in SOURCE seconds with cx/cy
      // normalized 0..1 in the source frame → survives cuts/reorder/ripple (those only
      // respread clips, never touch source time). Zoom stays user-controlled (tightness);
      // the track only sets position, overriding manual pan while enabled.
      //
      // Preview: this sampler writes gpVideo.style.left/top; the engine's mirrorGeometry
      // copies it onto the wc canvas on the very next line of its tick. Render: the
      // engine-capture path replays this same engine (so the sampler fires) and
      // drawCanvasFrame re-reads gpVideo.style.left/top per frame → automatic parity.
      // Smoothing/interpolation tunables live on window.wcReframe.cfg — edit then
      // window.wcReframe.rebake() to re-apply without re-tracking (render inherits it).
      //   smoothMs  temporal smoothing window (↑ floatier/cinematic, ↓ snappier)
      //   deadzone  ignore subject motion within this radius of the held centre (norm 0..1)
      //   maxStep   optional cap on camera speed (norm units / sec; 0 = off)
      function _smoothTrack(raw, cfg) {
        const n = raw.length;
        if (n < 2) return raw.slice();
        const tau = Math.max(0.001, (cfg.smoothMs || 0) / 1000);
        // Zero-phase EMA: forward + backward, averaged → removes jitter with no net lag.
        const fx = new Float64Array(n), fy = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
        fx[0] = raw[0].cx; fy[0] = raw[0].cy;
        for (let i = 1; i < n; i++) {
          const dt = raw[i].t - raw[i - 1].t, a = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
          fx[i] = fx[i - 1] + (raw[i].cx - fx[i - 1]) * a;
          fy[i] = fy[i - 1] + (raw[i].cy - fy[i - 1]) * a;
        }
        bx[n - 1] = raw[n - 1].cx; by[n - 1] = raw[n - 1].cy;
        for (let i = n - 2; i >= 0; i--) {
          const dt = raw[i + 1].t - raw[i].t, a = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
          bx[i] = bx[i + 1] + (raw[i].cx - bx[i + 1]) * a;
          by[i] = by[i + 1] + (raw[i].cy - by[i + 1]) * a;
        }
        // Deadzone + optional speed cap → camera holds through micro-movement, then glides.
        const dz = cfg.deadzone || 0, maxStep = cfg.maxStep || 0;
        const out = new Array(n);
        let ox = (fx[0] + bx[0]) / 2, oy = (fy[0] + by[0]) / 2;
        for (let i = 0; i < n; i++) {
          const tx = (fx[i] + bx[i]) / 2, ty = (fy[i] + by[i]) / 2;
          let ddx = tx - ox, ddy = ty - oy; const dist = Math.hypot(ddx, ddy);
          if (dist > dz && dist > 0) {
            let mv = (dist - dz) / dist;
            if (maxStep > 0) { const dt = i ? raw[i].t - raw[i - 1].t : 0; const cap = maxStep * dt; if (dist * mv > cap) mv = cap / dist; }
            ox += ddx * mv; oy += ddy * mv;
          }
          out[i] = { t: raw[i].t, cx: ox, cy: oy, w: raw[i].w };
        }
        return out;
      }
      // Linear interp on a baked track; coast (hold) before first / after last.
      function _interpTrack(k, t) {
        const n = k.length; if (!n) return null;
        if (t <= k[0].t) return k[0];
        if (t >= k[n - 1].t) return k[n - 1];
        let lo = 0, hi = n - 1;
        while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
        const a = k[lo], b = k[hi], f = (t - a.t) / ((b.t - a.t) || 1);
        return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
      }
      // Effective baked track for a clip: its own override.tracking (baked + cached by raw
      // reference) when broken away, else the base (window.wcReframe) track. null = no pan.
      const _clipTrackCache = new Map();
      function _bakedTrackFor(clip) {
        const ovr = clip && clip.override && clip.override.tracking;
        if (ovr) {
          if (!ovr.enabled || !(ovr.raw && ovr.raw.length)) return null;   // clip tracking explicitly off / empty
          const c = _clipTrackCache.get(clip.id);
          if (c && c.raw === ovr.raw) return c.baked;
          const baked = _smoothTrack(ovr.raw, _reframe.cfg);
          _clipTrackCache.set(clip.id, { raw: ovr.raw, baked });
          return baked;
        }
        return (_reframe.enabled && _reframe.track && _reframe.track.length) ? _reframe.track : null;   // inherit base
      }
      const _reframe = (window.wcReframe ||= {
        enabled: false,
        raw: [],                            // unsmoothed [{ t, cx, cy }] in source seconds
        track: [],                          // baked (smoothed) path the sampler reads
        cfg: { smoothMs: 550, deadzone: 0.05, maxStep: 0 },
        setTrack(pts) { this.raw = (pts || []).slice().sort((a, b) => a.t - b.t); this.rebake(); },
        rebake()      { this.track = _smoothTrack(this.raw, this.cfg); _clipTrackCache.clear(); return `[reframe] rebaked ${this.track.length} pts (smoothMs ${this.cfg.smoothMs}, deadzone ${this.cfg.deadzone})`; },
        enable(on)    { this.enabled = on !== false; if (this.enabled) this._suspend = false; },   // re-enabling must clear a stuck inspect-suspend
        clear()       { this.raw = []; this.track = []; this.enabled = false; this._suspend = false; },
        // Phase-1 validation only (no CV): a horizontal sine sweep across the actual
        // source window (works for live AND vod windows where source time is offset).
        testSine(sweeps = 3, lo = 0.28, hi = 0.72) {
          const win = window.canvasAPI?.getSourceWindow?.();
          const t0  = win ? win.start : 0;
          const t1  = win ? win.end   : (gpVideo.duration || 30);
          const span = Math.max(1, t1 - t0);
          const N = Math.max(8, Math.round(span * 4));
          const pts = [];
          for (let i = 0; i <= N; i++) {
            const t  = t0 + (i / N) * span;
            const ph = (i / N) * sweeps * 2 * Math.PI;
            pts.push({ t, cx: lo + (hi - lo) * (0.5 - 0.5 * Math.cos(ph)), cy: 0.5 });
          }
          this.setTrack(pts); this.enabled = true;
          return `[reframe] sine track: ${pts.length} pts over ${t0.toFixed(1)}–${t1.toFixed(1)}s — enabled`;
        },
        sample(t) { return _interpTrack(this.track, t); },
      });

      function _applyReframe(srcSec, ot, clip) {
        if (_reframe._suspend) return;
        // (1) PER-CLIP MODE + LAYOUT — re-apply the active clip's effective mode/layout on each
        //     clip change (engine passes `clip`; the engine-off fallback omits it).
        if (clip !== undefined) {
          const cid = clip ? clip.id : null;
          if (cid !== _lastLayoutClipId) {
            _lastLayoutClipId = cid;
            // Let the targeter UI follow the playhead (indicator/button reflect the now-playing clip).
            try { window.dispatchEvent(new CustomEvent('clipChanged', { detail: { id: cid } })); } catch (_) {}
            // FACECAM CROP — per-clip `override.facecam` (which region/who the split's bottom shows) ELSE the
            // base crop (Supabase/injected). The facecam canvas reads `item._crop` every frame, so swapping it
            // here changes the bottom panel per clip; `item._cropValid` gates split rendering + coercion.
            const fcOv = clip && clip.override && clip.override.facecam;
            const eff = (fcOv && isFinite(fcOv.x1) && isFinite(fcOv.x2) && fcOv.x2 > fcOv.x1 && fcOv.y2 > fcOv.y1) ? fcOv : (item._cropBase || null);
            if (eff) {
              item._crop = eff;
              item._cropValid = true;
              if (!item._fcCanvasInit && fcHold && gpVideo) { item._fcCanvasInit = true; initFacecamCanvas(item, gpVideo, fcHold, eff.x1, eff.y1, eff.x2, eff.y2); bindSplitCropDrag(fcHold, item); }
            } else {
              item._cropValid = false;
            }
            // MODE: this clip's OWN override.mode else base — ISOLATED, no cascade. Switch only on an
            // actual change (reuses the tested inner applyMode — DOM swap WITHOUT touching modeStates).
            const effMode = (clip && clip.override && clip.override.mode) || frame._baseMode;
            const modeChanged = effMode && effMode !== frame._currentMode;
            if (modeChanged) {
              applyMode(effMode, { ...modeRefs, hasFacecam: item._cropValid ?? false, hasChatSplit: item._hasChatSplit ?? false });
              if (effMode === 'is-overlay') {   // restore base overlay facecam placement (per-clip placement = Phase B refinement)
                const ov = modeStates['is-overlay'], fw = frame.clientWidth, fh = frame.clientHeight;
                if (ov && ov.fcW && fcHold) {
                  fcHold.style.position = 'absolute';
                  fcHold.style.width = `${ov.fcW * fw}px`; fcHold.style.height = `${ov.fcH * fh}px`;
                  fcHold.style.left  = `${ov.fcX * fw}px`; fcHold.style.top    = `${ov.fcY * fh}px`;
                }
              }
            }
            // LAYOUT: mode-aware. SPLIT cascades (shared framing across a split chain); FILL/OVERLAY
            // are independent (own override else base) so a per-clip punch-in doesn't bleed across a
            // cut. Either way, editing a clip writes its OWN override — only the inheritance differs.
            const L = effMode === 'is-split'
              ? _cascadeOverride(tracks.video.clips, clip, 'layout')
              : (clip && clip.override && clip.override.layout);
            if (L) { applyLayout(L); _lastLayoutWasOverride = true; }
            else if (modeChanged || _lastLayoutWasOverride) { applyLayout(modeStates[frame._currentMode]); _lastLayoutWasOverride = false; }
          }
        }
        // (1b) FACECAM TRACK — TIME-VARYING split bottom crop (keyframes from the scene graph). A static
        // box is only right for fixed overlay cams; IRL faces MOVE, so the crop follows the person. The
        // facecam canvas reads item._crop every frame, so updating it here animates the panel for free.
        if (srcSec >= 0) {
          const fct = clip && clip.override && clip.override.facecamTrack;
          if (fct && fct.length && item) {
            const b = _interpFcTrack(fct, srcSec);
            if (b) item._crop = b;
          }
        }
        // (2) TRACKING — effective track (clip override ?? base) pans the window each frame.
        if (!(srcSec >= 0)) return;
        const trk = _bakedTrackFor(clip);
        if (!trk || !trk.length) return;
        const p = _interpTrack(trk, srcSec);
        if (!p) return;
        const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
        const dw = gpVideo.offsetWidth,  dh = gpVideo.offsetHeight;
        if (!hw || !dw) return;
        gpVideo.style.left = dw > hw ? `${Math.max(hw - dw, Math.min(0, hw / 2 - p.cx * dw))}px` : `${(hw - dw) / 2}px`;
        gpVideo.style.top  = dh > hh ? `${Math.max(hh - dh, Math.min(0, hh / 2 - p.cy * dh))}px` : `${(hh - dh) / 2}px`;
      }

      // Engine active → driven per-frame by the time-layer compositor (srcSec, ot, clip).
      (window.wcTimeLayers ||= []).push((srcSec, ot, clip) => _applyReframe(srcSec, ot, clip));
      // Fallback (engine off): gpVideo drives it directly.
      gpVideo.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) _applyReframe(gpVideo.currentTime); });
      // Any clip change (edit/reset/trim) → force the next frame to re-apply the effective
      // layout, so a reset/override reflects immediately even while parked on the clip.
      window.addEventListener('clipsChanged', () => { _lastLayoutClipId = '__force__'; });
    }

    
    const musicState = { duration: 0 };
    const tracks = {
      video: { trimIn: 0, trimOut: 0, cuts: [], clips: [] },
      title: { start: 0, end: null },
      image: { start: 0, end: null },
      music: { start: 0, end: null },
    };

    function getTrackBounds() {
      const duration = gpVideo.duration || 0;
      return {
        duration,
        effectiveStart: tracks.video.trimIn,
        effectiveEnd:   Math.max(tracks.video.trimIn, duration - tracks.video.trimOut),
      };
    }
  
    function clampSecondaryTracks() {
      const { effectiveStart, effectiveEnd, duration } = getTrackBounds();
      Object.keys(tracks).forEach(name => {
        if (name === 'video') return;
        const t = tracks[name];
        t.start = Math.max(effectiveStart, t.start ?? effectiveStart);
        const resolvedEnd = t.end ?? duration;
        t.end = Math.max(t.start, Math.min(effectiveEnd, resolvedEnd));
      });
      if (tracks.music && musicState.duration > 0) {
        const maxEnd = tracks.music.start + musicState.duration;
        if (tracks.music.end > maxEnd) {
          tracks.music.end = Math.min(effectiveEnd, maxEnd);
        }
      }
    }
  
    let _loopPending = false;

    gpVideo.addEventListener('timeupdate', () => {
      if (!interactive || frame._rendering) return;
      if (gpVideo.seeking || _loopPending) return;
      if (tracks.video.clips?.length > 0) return;
      const { effectiveStart, effectiveEnd, duration } = getTrackBounds();
      const t = gpVideo.currentTime;

      if (isFinite(effectiveEnd) && effectiveEnd > effectiveStart) {
        if (t < effectiveStart) {
          _loopPending = true;
          gpVideo.currentTime = effectiveStart;
          gpVideo.addEventListener('seeked', () => { _loopPending = false; }, { once: true });
        } else if (t >= effectiveEnd) {
          _loopPending = true;
          gpVideo.currentTime = effectiveStart;
          gpVideo.addEventListener('seeked', () => { _loopPending = false; }, { once: true });
        }
      }

      if (isFinite(duration) && duration > 0) {
        if (titleHold?._userVisible !== false) {
          const inTitle = t >= (tracks.title.start ?? 0) && t <= (tracks.title.end ?? duration);
          titleHold.style.visibility = inTitle ? '' : 'hidden';
        }
        if (imgHold?._userVisible !== false) {
          const inImage = t >= (tracks.image.start ?? 0) && t <= (tracks.image.end ?? duration);
          imgHold.style.visibility = inImage ? '' : 'hidden';
        }
      }
    });

    gpVideo.addEventListener('ended', () => {
      if (!interactive || _loopPending || frame._rendering) return;
      if (tracks.video.clips?.length > 0) return;
      const { effectiveStart, effectiveEnd } = getTrackBounds();
      if (!isFinite(effectiveEnd) || effectiveEnd <= effectiveStart) return;
      _loopPending = true;
      gpVideo.currentTime = effectiveStart;
      gpVideo.addEventListener('seeked', () => {
        _loopPending = false;
        gpVideo.play().catch(() => {});
      }, { once: true });
    });
  
    let fcDragBound   = false;
    let fcDragCleanup = null;

    // Persist the overlay facecam placement so it survives clip-to-clip transitions. Leaving overlay
    // (sampler applyMode) CLEARS fcHold's inline styles and the inner applyMode never saves them, so
    // without this the cam reset to the top-left default on re-entry. We write the normalized geom
    // into modeStates['is-overlay'] (which _applyReframe's overlay restore reads on clip change) on
    // drag-end and resize-end. Base placement (shared across overlay clips) — matches what render reads.
    function _commitOverlayFacecam() {
      if (!fcHold || frame._currentMode !== 'is-overlay') return;
      const fw = frame.clientWidth || 1, fh = frame.clientHeight || 1;
      modeStates['is-overlay'] = {
        ...(modeStates['is-overlay'] || {}),
        fcX: (parseFloat(fcHold.style.left) || 0) / fw,
        fcY: (parseFloat(fcHold.style.top)  || 0) / fh,
        fcW: fcHold.offsetWidth  / fw,
        fcH: fcHold.offsetHeight / fh,
      };
    }

    function bindFcDrag() {
      if (fcDragBound || !fcHold) return;
      fcDragBound = true;

      if (!fcHold._overlayPositioned) {
        fcHold._overlayPositioned = true;
        fcHold.style.position = 'absolute';
        fcHold.style.left     = `${frame.clientWidth  * 0.06}px`;
        fcHold.style.top      = `${frame.clientHeight * 0.65}px`;
      }

      fcHold.style.cursor = 'grab';
      fcHold.style.touchAction = 'none';   // own touch drags → don't let the browser scroll the page
      let ox = 0, oy = 0, sx = 0, sy = 0, dragLive = false;

      function onDown(e) {
        if (e.target.dataset.overlayHandle) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault(); e.stopPropagation();
        ox = parseFloat(fcHold.style.left) || 0;
        oy = parseFloat(fcHold.style.top)  || 0;
        sx = e.clientX / getScale();
        sy = e.clientY / getScale();
        dragLive = true;
        fcHold.setPointerCapture(e.pointerId);
        fcHold.style.cursor = 'grabbing';
      }
      function onMove(e) {
        if (!dragLive) return;
        let nx = ox + (e.clientX / getScale() - sx);
        let ny = oy + (e.clientY / getScale() - sy);
        [nx, ny] = clampHoldInFrame(nx, ny, fcHold, frame);
        [nx, ny] = snapToCenter(nx, ny, fcHold, frame);
        fcHold.style.left = `${nx}px`;
        fcHold.style.top  = `${ny}px`;
      }
      function onUp() {
        if (!dragLive) return;
        dragLive = false;
        fcHold.style.cursor = 'grab';
        hideSnapGuides(frame);
        _commitOverlayFacecam();   // save dragged position so it survives clip re-entry
      }

      fcHold.addEventListener('pointerdown',   onDown);
      fcHold.addEventListener('pointermove',   onMove);
      fcHold.addEventListener('pointerup',     onUp);
      fcHold.addEventListener('pointercancel', onUp);

      _addResizeHandles(fcHold, frame, getScale, 60, 60, null, _commitOverlayFacecam);   // save resized geom on resize-end

      fcDragCleanup = () => {
        fcHold.removeEventListener('pointerdown',   onDown);
        fcHold.removeEventListener('pointermove',   onMove);
        fcHold.removeEventListener('pointerup',     onUp);
        fcHold.removeEventListener('pointercancel', onUp);
        fcHold.querySelectorAll('[data-overlay-handle]').forEach(h => h.remove());
        fcHold._resizeObs?.disconnect(); fcHold._resizeObs = null;
        fcHold.style.outline = '';
        fcHold.style.cursor = '';
        fcHold.style.touchAction = '';   // release touch handling when not overlay-draggable
        fcDragBound = false;
      };
    }
  
    function unbindFcDrag() { fcDragCleanup?.(); fcDragCleanup = null; }
  
    let splitPct   = 0.5;
    let applySplit = null;
    frame._baseMode = 'is-full';   // base mode clips inherit — stored on the shared `frame` so buildPanelAPI (getEffectiveMode) can read it too (per-clip override.mode breaks away)
  
    if (splitHandle && gpHold && fcHold) {
      splitHandle.style.display = 'none';
  
      applySplit = pct => {
        splitPct = Math.max(0.1, Math.min(0.9, pct));
        modeStates['is-split'] = { ...modeStates['is-split'], splitPct };   // keep persisted ratio in sync (drag calls applySplit directly)
        gpHold.style.setProperty('height', `${splitPct * 100}%`,       'important');
        gpHold.style.setProperty('top',    '0%',                        'important');
        fcHold.style.setProperty('height', `${(1 - splitPct) * 100}%`, 'important');
        fcHold.style.setProperty('top',    `${splitPct * 100}%`,        'important');
        splitHandle.style.top       = `${splitPct * 100}%`;
        splitHandle.style.transform = 'translateY(-50%)';
        // Move the overlay placement bar(s) onto the split seam. The visible bar is in
        // normal flow (position:relative) and the preview is CSS-scaled, so neither
        // `top:%` (it adds to the flow position) nor rect-based px is reliable. Instead
        // nudge each bar by a transform that shifts it from its NATURAL position to the
        // split handle (which sits on the seam), converting the viewport delta back to
        // layout px via the preview scale. Bars carry no transform of their own, so
        // horizontal layout is undisturbed. (Not auto-resize-safe; re-applied on every
        // split change + mode enter, which covers the interactive cases.)
        const _scale = (frame.getBoundingClientRect().height / (frame.offsetHeight || 1)) || 1;
        frame.querySelectorAll('.kt_overlay_placement_bar').forEach(_bar => {
          if (!splitHandle) return;
          _bar.style.transform = '';                                  // reset → measure natural position
          const br = _bar.getBoundingClientRect();
          if (br.height < 1) return;                                  // hidden variant
          const hr = splitHandle.getBoundingClientRect();
          const seamVp = hr.top + hr.height / 2;                      // handle is centred on the seam
          const dLayout = (seamVp - (br.top + br.height / 2)) / _scale;   // centre the bar on the seam
          _bar.style.setProperty('transform', `translateY(${dLayout.toFixed(1)}px)`, 'important');
        });
        applyGpZoom(gpZoom);
      };
  
      let live = false, startY = 0, startPct = 0;
      splitHandle.style.cursor = 'ns-resize';
      splitHandle.style.touchAction = 'none';   // own the vertical drag → don't scroll the page

      splitHandle.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        live = true; startY = e.clientY; startPct = splitPct;
        splitHandle.setPointerCapture(e.pointerId);
      });
      splitHandle.addEventListener('pointermove', e => {
        if (!live) return;
        applySplit(startPct + (e.clientY - startY) / getScale() / frame.clientHeight);
      });
      const endSplit = () => { live = false; };
      splitHandle.addEventListener('pointerup',     endSplit);
      splitHandle.addEventListener('pointercancel', endSplit);
  
      window.setSplitPct = pct => {
        if (frame._currentMode === 'is-split') {
          applySplit(pct);
        } else {
          splitPct = Math.max(0.1, Math.min(0.9, pct));
        }
        modeStates['is-split'] = { ...modeStates['is-split'], splitPct: splitPct };
      };

      // Re-apply on window resize so the pixel-measured overlay-bar alignment (which
      // depends on the live scale) stays on the seam. rAF-throttled; only in split mode.
      let _splitResizeQueued = false;
      window.addEventListener('resize', () => {
        if (frame._currentMode !== 'is-split' || _splitResizeQueued) return;
        _splitResizeQueued = true;
        requestAnimationFrame(() => { _splitResizeQueued = false; applySplit(splitPct); });
      }, { passive: true });
    }
  
    if (imgHold)  makeOverlayInteractive(imgHold,  frame, getScale);
    if (chatHold) makeOverlayInteractive(chatHold, frame, getScale);
  
    const allHolds = [gpHold, fcHold, titleHold, subHold, imgHold, chatHold].filter(Boolean);
    bindSelection(frame, allHolds);
  
    const modeRefs = {
      frame, gpHold, gpVideo, fcHold, chatHold, splitHandle,
      hasFacecam:   false,
      hasChatSplit: false,
      bindFcDrag,   unbindFcDrag,
      applyGpZoom,
      gpZoom:       () => gpZoom,
      applySplit:   (pct) => applySplit?.(pct),
      getSplitPct:  () => splitPct,
    };
  
    function applyModeFn(mode) {
      frame._baseMode = mode;   // applyModeFn is the GLOBAL switcher → this is the base all clips inherit
      const leavingMode = frame._currentMode;

      if (leavingMode && leavingMode !== mode) {
        if (leavingMode === 'is-full' || leavingMode === 'is-overlay') {
          const gpLeft = parseFloat(gpVideo.style.left) || 0;
          const gpTop  = parseFloat(gpVideo.style.top)  || 0;
          const gpHW   = gpHold.clientWidth  || 1;
          const gpHH   = gpHold.clientHeight || 1;
          const cL = (gpHW - gpVideo.offsetWidth)  / 2;
          const cT = (gpHH - gpVideo.offsetHeight) / 2;
          const saved = { zoom: gpZoom, panX: (gpLeft - cL) / gpHW, panY: (gpTop - cT) / gpHH };

          if (leavingMode === 'is-overlay' && fcHold) {
            const fw = frame.clientWidth || 1;
            const fh = frame.clientHeight || 1;
            saved.fcX = (parseFloat(fcHold.style.left) || 0) / fw;
            saved.fcY = (parseFloat(fcHold.style.top)  || 0) / fh;
            saved.fcW = fcHold.offsetWidth  / fw;
            saved.fcH = fcHold.offsetHeight / fh;
          }

          modeStates[leavingMode] = saved;
        }

        if (leavingMode === 'is-split') {
          modeStates['is-split'] = { ...modeStates['is-split'], splitPct: splitPct };
        }
      }

      if (mode === 'is-split') {
        const savedSplit = modeStates['is-split']?.splitPct;
        if (savedSplit !== undefined) {
          splitPct = savedSplit;
        }
      }

      applyMode(mode, {
        ...modeRefs,
        hasFacecam:   item._cropValid    ?? false,
        hasChatSplit: item._hasChatSplit ?? false,
      });

      const overlaySaved = modeStates['is-overlay'];
      if (frame._currentMode === 'is-overlay' && overlaySaved?.fcW && fcHold) {
        const fw = frame.clientWidth;
        const fh = frame.clientHeight;
        fcHold.style.position = 'absolute';
        fcHold.style.width    = `${overlaySaved.fcW * fw}px`;
        fcHold.style.height   = `${overlaySaved.fcH * fh}px`;
        fcHold.style.left     = `${overlaySaved.fcX * fw}px`;
        fcHold.style.top      = `${overlaySaved.fcY * fh}px`;
        fcHold._overlayPositioned = true;
      }

      requestAnimationFrame(() => {
        const enteringMode = frame._currentMode;
        if (enteringMode === 'is-split') {
          _prevGpHoldW = gpHold?.clientWidth  || _prevGpHoldW;
          _prevGpHoldH = gpHold?.clientHeight || _prevGpHoldH;
          return;
        }

        const restored = restoreModeZoomPan(enteringMode);
        if (!restored && gpVideo.videoWidth) {
          const defaultZoom = calcDefaultZoom(gpHold, gpVideo);
          if (defaultZoom !== null) applyGpZoom(defaultZoom);
        }

        _prevGpHoldW = gpHold?.clientWidth  || _prevGpHoldW;
        _prevGpHoldH = gpHold?.clientHeight || _prevGpHoldH;
      });
    }
  
    // Single routed mode setter for ALL entry points (panel buttons via setLayoutMode, canvasAPI.setMode):
    // a selected clip → break it away to override.mode (sampler re-applies on clipsChanged); else base.
    function _setModeRouted(mode) {
      // Split with no facecam crop AND no chat = identical to fill (applyMode coerces it anyway).
      // Ignore the request so it can't be toggled/restored into a meaningless split.
      if (mode === 'is-split' && window.canvasAPI?.canSplit?.() === false) return;
      const id = window.canvasAPI?.getEditClip?.();
      if (id) {
        const clips = (tracks.video.clips || []).map(c => c.id === id ? { ...c, override: { ...(c.override || {}), mode } } : c);
        window.canvasAPI?.setClips?.(clips);
      } else {
        applyModeFn(mode);
      }
      // The panel mode buttons' click handler doesn't re-sync the active state, so drive it
      // ourselves from the authoritative effective mode. Run now AND next frame so this also
      // wins over any Wized/Webflow native class toggle that fires after this handler.
      window.syncPanelUI?.();
      requestAnimationFrame(() => window.syncPanelUI?.());
      // Refresh the mode lane. Clip-mode edits also fire clipsChanged (via setClips), but a BASE
      // mode change (nothing selected) wouldn't — so signal it explicitly here.
      window.dispatchEvent(new CustomEvent('modeChanged'));
    }

    item._applyMode = applyModeFn;
    applyModeFn('is-full');
  
    buildPanelAPI({
      frame, gpHold, gpVideo, fcHold, chatHold,
      titleHold, titleText, subHold, textGroup,
      imgHold, imgEl,
      getGpZoom:           () => gpZoom,
      applyGpZoom,
      applyModeFn,
      getSplitPct:         () => splitPct,
      tracks,
      getTrackBounds,
      clampSecondaryTracks,
      modeStates,
      musicState, 
    });
  
    window.setLayoutMode = _setModeRouted;   // panel mode buttons route per-clip (edit target) or base
  
  }
  
  function reapplyCrop(item) {
    const gpVideo   = item.querySelector('[wized="stream_clip_video"]');
    const fcHold    = item.querySelector('.facecam_hold');
    const chatHold  = item.querySelector('.chat_hold');
    const titleHold = item.querySelector('.title_hold');
    const clipFrame = item.querySelector('.clip_canvas');
    const gpHold    = item.querySelector('.gameplay_hold');
  
    const titleStr = item.querySelector('[wized="stream_clip_title-list"]')?.textContent.trim();
    if (titleStr && titleStr !== item._lastRenderedTitle) {
      item._lastRenderedTitle = titleStr;
      if (titleHold?.clientWidth > 0) {
        renderTitlePills(titleHold, titleStr);
      } else {
        requestAnimationFrame(() => renderTitlePills(titleHold, titleStr));
      }
    }
  
    const imageUrl = item.querySelector('[wized="stream_clip_image_url"]')?.textContent.trim();
    if (imageUrl) {
      const clipId   = item.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
      const hasSaved = !!localStorage.getItem(`canvas_state_${clipId}`);
      window.canvasAPI?.setImage(imageUrl);
      if (!hasSaved) {
        if (window.canvasAPI) {
          const imgHold = item.querySelector('.image_hold');
          const defaultScale = imgHold?._wfDefaultScale ?? 0.25;
          const defaultX = imgHold?._wfDefaultX ?? 0.5;
          const defaultY = imgHold?._wfDefaultY ?? 0.3;
          window.canvasAPI.setImageScale(defaultScale);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.canvasAPI.setImagePosition(defaultX, defaultY);
            window.canvasAPI.setImageVisible(true);
            document.querySelector('[wized="toggle_image_overlay"]')?.classList.add('is-active');
          }));
        } else {
          const imgHold = item.querySelector('.image_hold');
          if (imgHold) imgHold.style.visibility = '';
        }
      }
    }
  
    if (!item._subtitlesBound && gpVideo) {
      const subPill = item.querySelector('.subtitle_pill');
      const subText = item.querySelector('.subtitle_text');
      const subHold = item.querySelector('.subtitle_hold');
      const raw     = item.querySelector('[wized="stream_clip_transcript"]')?.textContent.trim();
      if (raw) {
        try {
          const transcript = _rebaseTranscriptForSegment(JSON.parse(raw));
          if (Array.isArray(transcript) && transcript.length) {
            const subMode = subHold?.dataset.subtitleMode ?? 'word';
            if (subMode === 'chunk') {
              bindSubtitlesChunk(gpVideo, transcript, subHold, subPill);
            } else {
              bindSubtitles(gpVideo, transcript, subPill, subText);
            }
            item._subtitlesBound = true;
          }
        } catch (_) {}
      }
    }
  
    if (chatHold && gpVideo && !chatHold._videoInit) {
      const chatUrl = item.querySelector('[wized="stream_clip_chat"]')?.textContent.trim();
      if (chatUrl) {
        chatHold._videoInit = true;
        item._hasChatSplit  = true;
  
        const vid = document.createElement('video');
        vid.src     = chatUrl;
        vid.muted   = true;
        vid.preload = 'metadata';   // was 'auto' — don't eager-download the chat file and starve the gameplay demux; it buffers when played
        vid.setAttribute('playsinline', '');
        Object.assign(vid.style, {
          width: '100%', height: '100%', objectFit: 'cover',
          display: 'block', pointerEvents: 'none', mixBlendMode: 'screen',
        });
        chatHold.insertBefore(vid, chatHold.firstChild);
        vid.addEventListener('loadedmetadata', () => { vid.currentTime = gpVideo.currentTime; }, { once: true });
        gpVideo.addEventListener('play', () => {
          const drift = Math.abs(vid.currentTime - gpVideo.currentTime);
          if (drift > 0.1) {
            vid.addEventListener('seeked', () => vid.play().catch(() => {}), { once: true });
            vid.currentTime = gpVideo.currentTime;
          } else {
            vid.play().catch(() => {});
          }
        });
        gpVideo.addEventListener('pause',  () => vid.pause());
        bindFollowerSeekFreeze(vid, gpVideo, { blend: 'screen' });
        vid.load();
      }
    }
  
    if (!item._applyMode && gpVideo) {
      // Nudge a first-frame decode so the preview shows the opening frame instead of black before
      // the WebCodecs engine takes over. Trigger on loadedMETADATA (readyState 1), NOT loadeddata
      // (readyState 2): with preload='metadata' the browser won't reach readyState 2 on its own, so
      // waiting on loadeddata never fires → black gap. Setting currentTime forces a small range
      // fetch + decode of that frame (cheap — not the whole file).
      const _nudgeFirstFrame = () => { try { gpVideo.currentTime = 0.1; } catch (_) {} };
      if (gpVideo.readyState >= 1) _nudgeFirstFrame();
      else gpVideo.addEventListener('loadedmetadata', _nudgeFirstFrame, { once: true });
    }
  
    if (!gpVideo || !fcHold) return;
  
    const hasCrop  = item.querySelector('[wized="stream_clip_contains_facecam"]')?.textContent.trim().toLowerCase() === 'true';
    const x1 = parseFloat(item.querySelector('[wized="stream_clip_facecam_x1"]')?.textContent.trim());
    const y1 = parseFloat(item.querySelector('[wized="stream_clip_facecam_y1"]')?.textContent.trim());
    const x2 = parseFloat(item.querySelector('[wized="stream_clip_facecam_x2"]')?.textContent.trim());
    const y2 = parseFloat(item.querySelector('[wized="stream_clip_facecam_y2"]')?.textContent.trim());
    // Supabase crop wins; else fall back to an INJECTED crop (setFacecamCrop — e.g. auto-layout's
    // scan-detected cam when Supabase has none), so split renders + survives Wized re-renders.
    let box = (hasCrop && [x1, y1, x2, y2].every(isFinite) && x2 > x1 && y2 > y1) ? { x1, y1, x2, y2 } : null;
    if (!box && clipFrame?._cropInjected) box = clipFrame._cropInjected;   // injected crop lives on the .clip_canvas (shared with the api closure's `frame`)
    const cropValid = !!box;

    const wasValid  = item._cropValid;
    item._cropValid = cropValid;

    if (cropValid) {
      item._crop = box;
      item._cropBase = box;   // the DEFAULT crop (Supabase/injected) — _applyReframe falls back to it per clip
      fcHold.classList.add('has-crop');
      if (!item._fcCanvasInit) {
        item._fcCanvasInit = true;
        initFacecamCanvas(item, gpVideo, fcHold, box.x1, box.y1, box.x2, box.y2);
      }
      bindSplitCropDrag(fcHold, item);   // manual per-clip crop pan (drag the bottom panel)
      if (item._applyMode) {
        if (!wasValid) item._applyMode('is-split');
      } else {
        MODES.forEach(m => { clipFrame?.classList.remove(m); gpHold?.classList.remove(m); fcHold.classList.remove(m); });
        clipFrame?.classList.add('is-split');
        gpHold?.classList.add('is-split');
        fcHold.classList.add('is-split');
        fcHold.style.display = '';
      }
    } else {
      if (item._applyMode) {
        if (wasValid !== false) item._applyMode(item._hasChatSplit ? 'is-split' : 'is-full');
      } else {
        MODES.forEach(m => { clipFrame?.classList.remove(m); gpHold?.classList.remove(m); fcHold.classList.remove(m); });
        clipFrame?.classList.add('is-full');
        gpHold?.classList.add('is-full');
        fcHold.style.display = 'none';
      }
    }
  
    if (!item._applyMode && !item._canvasStateApplied) {
      const raw = item.querySelector('[wized="stream_clip_canvas_state"]')?.textContent.trim();
      if (raw) {
        try {
          const state = JSON.parse(raw);
          item._canvasStateApplied = true;
          applyPassiveState(item, state);
        } catch (_) {}
      }
    }
  }
  
  function bootCanvas() {
    document.querySelectorAll('[data-canvas="interactive"]').forEach(item => {
      if (!item.dataset.canvasInit) {
        item.dataset.canvasInit = '1';
        initCanvas(item, { interactive: true });
      }
      reapplyCrop(item);

      if (!item._dataObserver) {
        let debounce = null;
        const observer = new MutationObserver(() => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            reapplyCrop(item);
            requestAnimationFrame(() => window.syncPanelUI?.());
          }, 80);
        });
        const watchKeys = [
          'stream_clip_contains_facecam',
          'stream_clip_image_url',
          'stream_clip_title-list',
          'stream_clip_chat',
        ];
        watchKeys.forEach(key => {
          const el = item.querySelector(`[wized="${key}"]`);
          if (el) observer.observe(el, { childList: true, characterData: true, subtree: true });
        });
        item._dataObserver = observer;
      }

      requestAnimationFrame(() => window.syncPanelUI?.());
    });

    document.querySelectorAll('[data-canvas="passive"]').forEach(el => {
      if (!el.dataset.canvasInit) {
        el.dataset.canvasInit = '1';
        initCanvas(el, { interactive: false });
      }
      reapplyCrop(el);
    });
  }
  
  window.bootCanvas = bootCanvas;
  
  window.Wized = window.Wized || [];
  window.Wized.push(wized => {
    wized.on('requestEnd', bootCanvas);
  });
  bootCanvas();
  
  })();