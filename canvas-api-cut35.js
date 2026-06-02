(function () {
  'use strict';
  
  const ZOOM_MAX  = 4;
  const ZOOM_STEP = 0.10;
  // Touch device (no hover) → resize handles must stay visible + be big enough to tap.
  const _COARSE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  // iOS can't play a canvas captureStream in a <video> (renders black) → the blurred
  // letterbox bg is drawn from the engine frame into a canvas instead.
  const _IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
               || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  let _sourceBounds = null;
  
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
  function _addResizeHandles(hold, frame, getScale, minW, minH, getAspect) {
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
      _bindCorner(h, sx, sy, hold, frame, getScale, minW, minH, getAspect, a => { resizing += a ? 1 : -1; refresh(); });
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
          pillEl.style.visibility = '';
          pillEl?.classList.add('is-active');
        } else {
          pillEl.style.visibility = 'hidden';
          pillEl?.classList.remove('is-active');
          if (pillEl) pillEl.style.transform = '';
        }
      }
      // Per-frame entry animation on the active word (preset id read from its class).
      if (idx !== -1 && pillEl) {
        const styleId = (pillEl.className.match(/style-\d{3}/) || [''])[0];
        const a = _subAnim(styleId, ms - transcript[idx].start);
        pillEl.style.transformOrigin = 'center';
        pillEl.style.transform = `translateY(${a.dy}em) scale(${a.scale})`;
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
          const txt = pill.querySelector('.subtitle_text');
          if (txt) txt.textContent = word.text;
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
  
  function bindTrack(video, el, track) {
    if (!el || !track) return;
    const update = () => {
      const on = video.currentTime >= (track.start ?? 0)
              && video.currentTime <= (track.end   ?? Infinity);
      el.style.opacity       = on ? '1' : '0';
      el.style.pointerEvents = on ? ''  : 'none';
    };
    video.addEventListener('timeupdate', update);
    update();
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
  
    gpVideo.addEventListener('play', () => {
      document.querySelectorAll('[wized="stream_clip_video"]').forEach(v => {
        if (v !== gpVideo) v.pause();
      });
      item.querySelector('#play_button')?.classList.add('is-playing');
    });
    gpVideo.addEventListener('pause', () => item.querySelector('#play_button')?.classList.remove('is-playing'));
    gpVideo.addEventListener('ended', () => { item.querySelector('#play_button')?.classList.remove('is-playing'); tick(); });
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
    if (imgHold   && state.imageVisible === false) imgHold.style.visibility = 'hidden';
  
    if (imgHold && state.imageScale && state.imageVisible !== false) {
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

    let _titleStyle    = null;
    let _subtitleStyle = null;
    let _musicOffset   = 0;
    let _musicUrl      = null;
    let _musicBlobUrl  = null;
    let _musicVolume   = 0.8;
    let _musicMuted    = false;
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
      setMode(mode)            { applyModeFn(mode); },
      getMode()                { return frame._currentMode ?? 'is-full'; },
      setTitle(str)            { renderTitlePills(titleHold, str); },
      setTitleVisible(bool)    { if (titleHold) { titleHold._userVisible = bool; titleHold.style.visibility = bool ? '' : 'hidden'; } },
      setTitleZone(zone)       { applyTextZones(textGroup, zone, textGroup?._subZone   ?? 'bottom'); },
      setSubtitleVisible(bool) { if (subHold) subHold.style.visibility = bool ? '' : 'hidden'; },
      setSubtitleZone(zone)    { applyTextZones(textGroup, textGroup?._titleZone ?? 'top', zone); },
      setChatVisible(bool)     { if (chatHold) chatHold.style.visibility = bool ? '' : 'hidden'; },
      setChatBlend(mode)       { const vid = chatHold?.querySelector('video'); if (vid) vid.style.mixBlendMode = mode; },
      setImage(url)            { if (imgEl) imgEl.src = url; },
      setImagePosition(x, y)  { applyImgPosition(x, y); },
      setImageScale(scale)     { applyImgScale(scale); },
      setImageVisible(bool)    { if (imgHold) { imgHold._userVisible = bool; imgHold.style.visibility = bool ? '' : 'hidden'; } },
      setFacecamVisible(bool)  { if (fcHold) fcHold.style.display = bool ? '' : 'none'; },
      

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
      setClips(arr)    {
        tracks.video.clips = [...(arr || [])];
        window.dispatchEvent(new CustomEvent('clipsChanged'));
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
          mode:            frame._currentMode ?? 'is-full',
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
          chatVisible:     chatHold  ? chatHold.style.visibility  !== 'hidden' : true,
          titleStyle:    _titleStyle,
          subtitleStyle: _subtitleStyle,
          musicOffset:   _musicOffset,
          musicDuration: musicState.duration,
          musicUrl:    _musicUrl,
          musicSrc:    _musicBlobUrl || _musicUrl,
          musicVolume: _musicVolume,
          musicMuted:  _musicMuted,
          clipVolume:  _clipVolume,
          chatBlend: (() => { const vid = chatHold?.querySelector('video'); return vid ? (vid.style.mixBlendMode || 'screen') : 'screen'; })(),
          imageVisible:   imgHold ? (imgHold._userVisible !== false) : false,
          facecamVisible: fcHold  ? fcHold.style.display !== 'none' : true,
          imgSrc: (imgEl?.getAttribute('src') ?? '').includes('placeholder') ? '' : (imgEl?.getAttribute('src') ?? ''),
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
        };
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
      gpVideo.addEventListener('play',  () => tlBtn.classList.add('is-playing'));
      gpVideo.addEventListener('pause', () => tlBtn.classList.remove('is-playing'));
      gpVideo.addEventListener('ended', () => tlBtn.classList.remove('is-playing'));
    }
  }
  
  function initCanvas(item, opts = {}) {
    const interactive = opts.interactive !== false;
  
    const frame       = item.querySelector('.clip_canvas');
    const gpHold      = item.querySelector('.gameplay_hold');
    const gpVideo     = item.querySelector('[wized="stream_clip_video"]');
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
    bindTrack(gpVideo, titleHold, cfg.titleTrack);
    bindTrack(gpVideo, imgHold,   cfg.imageTrack);
    bindTrack(gpVideo, subHold,   cfg.subtitleTrack);
  
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
        onEnd: () => {
          const mode = frame._currentMode;
          if (mode === 'is-full' || mode === 'is-overlay') {
            const gpLeft = parseFloat(gpVideo.style.left) || 0;
            const gpTop  = parseFloat(gpVideo.style.top)  || 0;
            const gpHW   = gpHold.clientWidth  || 1;
            const gpHH   = gpHold.clientHeight || 1;
            const cL = (gpHW - gpVideo.offsetWidth)  / 2;
            const cT = (gpHH - gpVideo.offsetHeight) / 2;
            modeStates[mode] = { zoom: gpZoom, panX: (gpLeft - cL) / gpHW, panY: (gpTop - cT) / gpHH };
          } else if (mode === 'is-split') {
            const gpLeft = parseFloat(gpVideo.style.left) || 0;
            const gpTop  = parseFloat(gpVideo.style.top)  || 0;
            const gpHW   = gpHold.clientWidth  || 1;
            const gpHH   = gpHold.clientHeight || 1;
            const cL = (gpHW - gpVideo.offsetWidth)  / 2;
            const cT = (gpHH - gpVideo.offsetHeight) / 2;
            modeStates['is-split'] = { ...modeStates['is-split'], panX: (gpLeft - cL) / gpHW, panY: (gpTop - cT) / gpHH };
          }
        },
      });
  
      gpHold.addEventListener('wheel', e => {
        e.preventDefault();
        const newZoom = gpZoom + (e.deltaY > 0 ? -1 : 1) * ZOOM_STEP;
        applyGpZoom(newZoom);
        window.canvasAPI?.setGameplayZoom(gpZoom);
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
      const _reframe = (window.wcReframe ||= {
        enabled: false,
        track: [],                          // [{ t, cx, cy }] sorted by t (source seconds)
        setTrack(pts) { this.track = (pts || []).slice().sort((a, b) => a.t - b.t); },
        enable(on)    { this.enabled = on !== false; },
        clear()       { this.track = []; this.enabled = false; },
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
        sample(t) {                         // linear interp; coast (hold) before first / after last
          const k = this.track, n = k.length;
          if (!n) return null;
          if (t <= k[0].t)     return k[0];
          if (t >= k[n - 1].t) return k[n - 1];
          let lo = 0, hi = n - 1;
          while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
          const a = k[lo], b = k[hi], f = (t - a.t) / ((b.t - a.t) || 1);
          return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
        },
      });

      function _applyReframe(srcSec) {
        if (!_reframe.enabled || !(srcSec >= 0)) return;
        const p = _reframe.sample(srcSec);
        if (!p) return;
        const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
        const dw = gpVideo.offsetWidth,  dh = gpVideo.offsetHeight;
        if (!hw || !dw) return;
        // Place the face centre (p.cx of the scaled frame width dw) at the window centre,
        // clamped to source edges — identical clamp to applyGpZoom / drag.
        const left = dw > hw ? Math.max(hw - dw, Math.min(0, hw / 2 - p.cx * dw)) : (hw - dw) / 2;
        const top  = dh > hh ? Math.max(hh - dh, Math.min(0, hh / 2 - p.cy * dh)) : (hh - dh) / 2;
        gpVideo.style.left = `${left}px`;
        gpVideo.style.top  = `${top}px`;
      }

      // Engine active → driven per-frame by the time-layer compositor (source time).
      (window.wcTimeLayers ||= []).push((srcSec) => _applyReframe(srcSec));
      // Fallback (engine off): gpVideo drives it directly.
      gpVideo.addEventListener('timeupdate', () => { if (!window.wcEngine?.isActive?.()) _applyReframe(gpVideo.currentTime); });
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
      }

      fcHold.addEventListener('pointerdown',   onDown);
      fcHold.addEventListener('pointermove',   onMove);
      fcHold.addEventListener('pointerup',     onUp);
      fcHold.addEventListener('pointercancel', onUp);

      _addResizeHandles(fcHold, frame, getScale, 60, 60, null);

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
  
    if (splitHandle && gpHold && fcHold) {
      splitHandle.style.display = 'none';
  
      applySplit = pct => {
        splitPct = Math.max(0.1, Math.min(0.9, pct));
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
        modeStates['is-split'] = { splitPct: splitPct };
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
          modeStates['is-split'] = { splitPct: splitPct };
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
  
    window.setLayoutMode = applyModeFn;
  
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
          const transcript = JSON.parse(raw);
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
        vid.preload = 'auto';
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
      if (gpVideo.readyState >= 2) {
        gpVideo.currentTime = 0.1;
      } else {
        gpVideo.addEventListener('loadeddata', () => {
          gpVideo.currentTime = 0.1;
        }, { once: true });
      }
    }
  
    if (!gpVideo || !fcHold) return;
  
    const hasCrop  = item.querySelector('[wized="stream_clip_contains_facecam"]')?.textContent.trim().toLowerCase() === 'true';
    const x1 = parseFloat(item.querySelector('[wized="stream_clip_facecam_x1"]')?.textContent.trim());
    const y1 = parseFloat(item.querySelector('[wized="stream_clip_facecam_y1"]')?.textContent.trim());
    const x2 = parseFloat(item.querySelector('[wized="stream_clip_facecam_x2"]')?.textContent.trim());
    const y2 = parseFloat(item.querySelector('[wized="stream_clip_facecam_y2"]')?.textContent.trim());
    const cropValid = hasCrop && [x1, y1, x2, y2].every(isFinite) && x2 > x1 && y2 > y1;
  
    const wasValid  = item._cropValid;
    item._cropValid = cropValid;
  
    if (cropValid) {
      item._crop = { x1, y1, x2, y2 };
      fcHold.classList.add('has-crop');
      if (!item._fcCanvasInit) {
        item._fcCanvasInit = true;
        initFacecamCanvas(item, gpVideo, fcHold, x1, y1, x2, y2);
      }
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