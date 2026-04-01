(function () {
'use strict';

const ZOOM_MAX  = 4;
const ZOOM_STEP = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCALE FRAME
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. DRAG SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function makeDraggable(handle, opts = {}) {
  const target = opts.target || handle;
  let ox = 0, oy = 0, sx = 0, sy = 0, live = false;

  handle.style.cursor = 'grab';

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    const scale = opts.getScale?.() ?? 1;
    ox = parseFloat(target.style.left) || 0;
    oy = parseFloat(target.style.top)  || 0;
    sx = e.clientX / scale;
    sy = e.clientY / scale;
    live = true;
    handle.setPointerCapture(e.pointerId);
    handle.style.cursor = 'grabbing';
    opts.onStart?.();
  });

  handle.addEventListener('pointermove', e => {
    if (!live) return;
    const scale = opts.getScale?.() ?? 1;
    let nx = ox + (e.clientX / scale - sx);
    let ny = oy + (e.clientY / scale - sy);
    if (opts.clamp) [nx, ny] = opts.clamp(nx, ny);
    target.style.left = `${nx}px`;
    target.style.top  = `${ny}px`;
    opts.onMove?.(nx, ny);
  });

  const end = () => {
    if (!live) return;
    live = false;
    handle.style.cursor = 'grab';
    opts.onEnd?.(parseFloat(target.style.left) || 0, parseFloat(target.style.top) || 0);
  };

  handle.addEventListener('pointerup',     end);
  handle.addEventListener('pointercancel', end);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OVERLAY INTERACTIVE
// ─────────────────────────────────────────────────────────────────────────────
function makeOverlayInteractive(hold, frame, getScale) {
  if (!hold) return;

  const draggable = hold.dataset.draggable === 'true';
  const resizable = hold.dataset.resizable === 'true';
  const minW      = parseFloat(hold.dataset.minWidth)  || 60;
  const minH      = parseFloat(hold.dataset.minHeight) || 60;

  if (draggable && (!hold.style.left || !hold.style.top)) {
    const fr = frame.getBoundingClientRect();
    const hr = hold.getBoundingClientRect();
    hold.style.left     = `${(hr.left - fr.left) / getScale()}px`;
    hold.style.top      = `${(hr.top  - fr.top)  / getScale()}px`;
    hold.style.position = 'absolute';
    if (!hold.style.width)  hold.style.width  = `${hr.width  / getScale()}px`;
    if (!hold.style.height) hold.style.height = `${hr.height / getScale()}px`;
  }

  if (draggable) {
    let ox = 0, oy = 0, sx = 0, sy = 0, live = false;
    hold.style.cursor = 'grab';

    hold.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('resize_handle')) return;
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
      nx = Math.max(0, Math.min(frame.clientWidth  - hold.offsetWidth,  nx));
      ny = Math.max(0, Math.min(frame.clientHeight - hold.offsetHeight, ny));
      hold.style.left = `${nx}px`;
      hold.style.top  = `${ny}px`;
    });

    const endDrag = () => { if (!live) return; live = false; hold.style.cursor = 'grab'; };
    hold.addEventListener('pointerup',     endDrag);
    hold.addEventListener('pointercancel', endDrag);
  }

  if (resizable && !hold.querySelector('.resize_handle')) {
    const handle = document.createElement('div');
    handle.className = 'resize_handle';
    Object.assign(handle.style, {
      position: 'absolute', bottom: '0', right: '0',
      width: '18px', height: '18px', cursor: 'se-resize',
      background: 'rgba(255,255,255,0.3)', borderRadius: '4px 0 0 0',
      zIndex: '10', touchAction: 'none',
    });
    hold.appendChild(handle);

    let startX, startY, startW, startH, live = false;

    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault(); e.stopPropagation();
      startX = e.clientX / getScale(); startY = e.clientY / getScale();
      startW = hold.offsetWidth; startH = hold.offsetHeight;
      const img = hold.querySelector('img');
      hold._aspectRatio = (img?.naturalWidth && img?.naturalHeight)
        ? img.naturalWidth / img.naturalHeight : null;
      live = true;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', e => {
      if (!live) return;
      const dx   = e.clientX / getScale() - startX;
      const maxW = frame.clientWidth  - (parseFloat(hold.style.left) || 0);
      const maxH = frame.clientHeight - (parseFloat(hold.style.top)  || 0);
      if (hold._aspectRatio) {
        const newW = Math.max(minW, Math.min(maxW, startW + dx));
        hold.style.width  = `${newW}px`;
        hold.style.height = `${Math.min(maxH, newW / hold._aspectRatio)}px`;
      } else {
        const dy = e.clientY / getScale() - startY;
        hold.style.width  = `${Math.max(minW, Math.min(maxW, startW + dx))}px`;
        hold.style.height = `${Math.max(minH, Math.min(maxH, startH + dy))}px`;
      }
    });

    const endResize = () => { live = false; };
    handle.addEventListener('pointerup',     endResize);
    handle.addEventListener('pointercancel', endResize);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TEXT ZONE POSITIONING
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 5. CLAMP
// ─────────────────────────────────────────────────────────────────────────────
function clampHoldInFrame(x, y, hold, frame) {
  return [
    Math.max(0, Math.min(frame.clientWidth  - hold.offsetWidth,  x)),
    Math.max(0, Math.min(frame.clientHeight - hold.offsetHeight, y)),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. WIZED DIV READER
// ─────────────────────────────────────────────────────────────────────────────
function wz(item, key) {
  return item.querySelector(`[wized="${key}"]`)?.textContent.trim() ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SUBTITLE TICKER
// ─────────────────────────────────────────────────────────────────────────────
function bindSubtitles(video, transcript, pillEl, textEl) {
  if (!transcript?.length || !textEl) return;
  let lastIdx = -2;

  if (pillEl) pillEl.style.visibility = 'hidden';

  video.addEventListener('timeupdate', () => {
    const ms  = video.currentTime * 1000;
    const idx = transcript.findIndex(w => ms >= w.start && ms < w.end);
    if (idx === lastIdx) return;
    lastIdx = idx;
    if (idx !== -1) {
      textEl.textContent      = transcript[idx].text;
      pillEl.style.visibility = '';
      pillEl?.classList.add('is-active');
    } else {
      pillEl.style.visibility = 'hidden';
      pillEl?.classList.remove('is-active');
    }
  });

  video.addEventListener('seeked', () => { lastIdx = -2; });
}

function bindSubtitlesChunk(video, transcript, subHold, pillTemplate, CHUNK_SIZE = 3) {
  if (!transcript?.length || !subHold || !pillTemplate) return;

  const chunks = [];
  for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
    chunks.push(transcript.slice(i, i + CHUNK_SIZE));
  }

  let lastChunkIdx = -2;
  let lastWordIdx  = -2;

  pillTemplate.style.position   = 'absolute';
  pillTemplate.style.visibility = 'hidden';
  pillTemplate.classList.remove('is-active');

  function renderChunk(chunkIdx, activeWordIdx) {
    const chunk = chunks[chunkIdx];

    if (chunkIdx !== lastChunkIdx) {
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
        p.classList.toggle('is-active', parseInt(p.dataset.wordIndex) === activeWordIdx);
      });
      lastWordIdx = activeWordIdx;
    }
  }

  function hideAll() {
    subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => p.remove());
    lastChunkIdx = -2;
    lastWordIdx  = -2;
  }

  video.addEventListener('timeupdate', () => {
    const ms = video.currentTime * 1000;

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
    } else if (lastChunkIdx !== -2) {
      const chunk     = chunks[lastChunkIdx];
      const firstWord = chunk[0];
      const lastWord  = chunk[chunk.length - 1];
      if (ms >= firstWord.start && ms < lastWord.end) {
        subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => {
          p.classList.remove('is-active');
        });
        lastWordIdx = -1;
      } else {
        hideAll();
      }
    }
  });

  video.addEventListener('seeked', () => { lastChunkIdx = -2; lastWordIdx = -2; });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. TRACK TIMING (static bind — legacy, used by editorConfig only)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 9. TITLE PILLS
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 10. PLAY CONTROLS + SEEK BAR
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 11. LAYER SELECTION
// ─────────────────────────────────────────────────────────────────────────────
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
  frame.addEventListener('pointerdown', () => {
    holds.forEach(h => h?.classList.remove('is-selected'));
    frame.dispatchEvent(new CustomEvent('layerselect', { bubbles: true, detail: { layer: null } }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. FACECAM CANVAS RENDERER
// ─────────────────────────────────────────────────────────────────────────────
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
    const vw = gpVideo.videoWidth,  vh = gpVideo.videoHeight;
    const cw = fcHold.clientWidth,  ch = fcHold.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    const srcX = x1 * vw, srcY = y1 * vh;
    const srcW = (x2 - x1) * vw, srcH = (y2 - y1) * vh;
    const scale = Math.max(cw / srcW, ch / srcH);
    const dw = srcW * scale, dh = srcH * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(gpVideo, srcX, srcY, srcW, srcH, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  function rafLoop() { drawFrame(); item._fcRafId = requestAnimationFrame(rafLoop); }
  function startLoop() { if (!item._fcRafId) rafLoop(); }
  function stopLoop() {
    if (item._fcRafId) { cancelAnimationFrame(item._fcRafId); item._fcRafId = null; }
    if (gpVideo.readyState >= 2) drawFrame();
  }

  if (!gpVideo._fcBound) {
    gpVideo.addEventListener('play',       startLoop);
    gpVideo.addEventListener('pause',      stopLoop);
    gpVideo.addEventListener('ended',      stopLoop);
    gpVideo.addEventListener('seeked',     () => { if (!item._fcRafId) drawFrame(); });
    gpVideo.addEventListener('loadeddata', drawFrame);
    gpVideo._fcBound = true;
  }

  if (gpVideo.readyState >= 2) drawFrame();
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. LAYOUT MODES
// ─────────────────────────────────────────────────────────────────────────────
const MODES = ['is-full', 'is-split', 'is-overlay'];

function applyMode(mode, refs) {
  const { frame, gpHold, gpVideo, fcHold, chatHold, splitHandle,
          hasFacecam, hasChatSplit,
          bindFcDrag, unbindFcDrag, applyGpZoom, gpZoom,
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
    fcHold?.querySelector('.resize_handle')?.remove();
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
          gpVideo.addEventListener('seeked', () => { splitVid.currentTime = gpVideo.currentTime; });
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

  const bgVid = gpHold?.querySelector('.bg_video');
  if (bgVid) bgVid.style.display = safeMode === 'is-split' ? 'none' : '';

  if (safeMode === 'is-overlay' && hasFacecam) {
    bindFcDrag?.();
  } else {
    unbindFcDrag?.();
  }

  frame._currentMode = safeMode;

  requestAnimationFrame(() => {
    if (safeMode === 'is-overlay' || safeMode === 'is-full') {
      const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
      const vw = gpVideo.videoWidth  || hw;
      const vh = gpVideo.videoHeight || hh;
      const coverScale = Math.max(hw / vw, hh / vh);
      const zoomMin    = Math.max(0.2, (hw / vw) / coverScale);
      applyGpZoom(zoomMin + (1 - zoomMin) * 0.3);
    } else {
      applyGpZoom(0);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. PANEL API
// ─────────────────────────────────────────────────────────────────────────────
function buildPanelAPI(refs) {
  const {
    frame, gpHold, gpVideo, fcHold, chatHold,
    titleHold, titleText, subHold, textGroup,
    imgHold, imgEl,
    getGpZoom, applyGpZoom, applyModeFn, getSplitPct,
    // ── Track system ──
    tracks, getTrackBounds, clampSecondaryTracks,
  } = refs;

  let imgScale = 0;
  let imgX     = 0.5;
  let imgY     = 0.3;

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
    // ── Mode ────────────────────────────────────────────────────────────────
    setMode(mode)            { applyModeFn(mode); },
    getMode()                { return frame._currentMode ?? 'is-full'; },

    // ── Title ────────────────────────────────────────────────────────────────
    setTitle(str)            { renderTitlePills(titleHold, str); },
    setTitleVisible(bool)    { if (titleHold) { titleHold._userVisible = bool; titleHold.style.visibility = bool ? '' : 'hidden'; } },
    setTitleZone(zone)       { applyTextZones(textGroup, zone, textGroup?._subZone   ?? 'bottom'); },

    // ── Subtitle ────────────────────────────────────────────────────────────
    setSubtitleVisible(bool) { if (subHold) subHold.style.visibility = bool ? '' : 'hidden'; },
    setSubtitleZone(zone)    { applyTextZones(textGroup, textGroup?._titleZone ?? 'top', zone); },

    // ── Chat ─────────────────────────────────────────────────────────────────
    setChatVisible(bool)     { if (chatHold) chatHold.style.visibility = bool ? '' : 'hidden'; },
    setChatBlend(mode)       {
      const vid = chatHold?.querySelector('video');
      if (vid) vid.style.mixBlendMode = mode;
    },

    // ── Image ────────────────────────────────────────────────────────────────
    setImage(url)            { if (imgEl) imgEl.src = url; },
    setImagePosition(x, y)  { applyImgPosition(x, y); },
    setImageScale(scale)     { applyImgScale(scale); },
    setImageVisible(bool)    { if (imgHold) { imgHold._userVisible = bool; imgHold.style.visibility = bool ? '' : 'hidden'; } },

    // ── Facecam ──────────────────────────────────────────────────────────────
    setFacecamVisible(bool)  { if (fcHold) fcHold.style.display = bool ? '' : 'none'; },

    // ── Gameplay ─────────────────────────────────────────────────────────────
    setGameplayZoom(z)       { applyGpZoom(z); },
    getGameplayZoom()        { return getGpZoom(); },

    // ── Playback ─────────────────────────────────────────────────────────────
    play()                   { gpVideo?.play().catch(() => {}); },
    pause()                  { gpVideo?.pause(); },
    seekTo(secs)             { if (gpVideo) gpVideo.currentTime = secs; },

    // ── Tracks ───────────────────────────────────────────────────────────────
    setMasterTrim(trimIn, trimOut) {
      const duration = gpVideo?.duration || 0;
      const safeIn   = Math.max(0, Math.min(trimIn,  duration));
      const safeOut  = Math.max(0, Math.min(trimOut, duration - safeIn));
      // Enforce minimum 0.5s playable window
      if (duration - safeIn - safeOut < 0.5) return;
      tracks.video.trimIn  = safeIn;
      tracks.video.trimOut = safeOut;
      clampSecondaryTracks();
    },

    setTrack(name, { start, end } = {}) {
      if (!tracks[name]) tracks[name] = { start: 0, end: null };
      const { effectiveStart, effectiveEnd } = getTrackBounds();
      if (start !== undefined) {
        tracks[name].start = Math.max(effectiveStart, Math.min(start, effectiveEnd));
      }
      if (end !== undefined) {
        tracks[name].end = end === null
          ? null
          : Math.max(tracks[name].start + 0.1, Math.min(end, effectiveEnd));
      }
    },

    getTrackBounds() { return getTrackBounds(); },

    getTracks()      { return JSON.parse(JSON.stringify(tracks)); },

    // ── State snapshot ───────────────────────────────────────────────────────
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
        titleVisible:    titleHold ? titleHold.style.visibility !== 'hidden' : true,
        subtitleVisible: subHold   ? subHold.style.visibility   !== 'hidden' : true,
        chatVisible:     chatHold  ? chatHold.style.visibility  !== 'hidden' : true,
        chatBlend: (() => {
          const vid = chatHold?.querySelector('video');
          return vid ? (vid.style.mixBlendMode || 'screen') : 'screen';
        })(),
        imageVisible:    imgHold ? imgHold.style.visibility !== 'hidden' : false,
        facecamVisible:  fcHold  ? fcHold.style.display     !== 'none'   : true,
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
        playing:    gpVideo ? !gpVideo.paused : false,
        // ── Tracks ────────────────────────────────────────────────────────
        tracks:     JSON.parse(JSON.stringify(tracks)),
      };
    },
  };

  const tlBtn = document.getElementById('timeline_play_button');
  if (tlBtn) {
    tlBtn.addEventListener('click', () => {
      gpVideo.paused ? gpVideo.play().catch(() => {}) : gpVideo.pause();
    });
    gpVideo.addEventListener('play',  () => tlBtn.classList.add('is-playing'));
    gpVideo.addEventListener('pause', () => tlBtn.classList.remove('is-playing'));
    gpVideo.addEventListener('ended', () => tlBtn.classList.remove('is-playing'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. MAIN INIT
// ─────────────────────────────────────────────────────────────────────────────
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
  const ro = new ResizeObserver(() => {
    scaleFrame(frame);
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

  if (transcript) {
    const subMode = subHold?.dataset.subtitleMode ?? 'word';
    if (subMode === 'chunk') {
      bindSubtitlesChunk(gpVideo, transcript, subHold, subPill);
    } else {
      bindSubtitles(gpVideo, transcript, subPill, subText);
    }
  }

  const cfg = window.editorConfig ?? {};
  bindTrack(gpVideo, titleHold, cfg.titleTrack);
  bindTrack(gpVideo, imgHold,   cfg.imageTrack);
  bindTrack(gpVideo, subHold,   cfg.subtitleTrack);

  if (cfg.imageOverlay?.url && imgEl) imgEl.src = cfg.imageOverlay.url;

  if (imgHold) imgHold.style.visibility = 'hidden';

  bindControls(item, gpVideo);

  requestAnimationFrame(() => applyTextZones(textGroup, 'top', 'bottom'));

  if (!interactive) return;

  frame.classList.add('is-interactive');

  // ── Gameplay zoom ────────────────────────────────────────────────────────
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
    const hasPan = dw > hw && (curLeft !== (hw - dw) / 2 || curTop !== (hh - dh) / 2);
    if (oldDw > 0 && hasPan) {
      const panCX = (curLeft + oldDw / 2) / hw;
      const panCY = (curTop  + oldDh / 2) / hh;
      cx = dw >= hw ? Math.max(hw - dw, Math.min(0, panCX * hw - dw / 2)) : (hw - dw) / 2;
      cy = dh >= hh ? Math.max(hh - dh, Math.min(0, panCY * hh - dh / 2)) : (hh - dh) / 2;
    } else {
      cx = dw >= hw ? Math.max(hw - dw, Math.min(0, (hw - dw) / 2)) : (hw - dw) / 2;
      cy = dh >= hh ? Math.max(hh - dh, Math.min(0, (hh - dh) / 2)) : (hh - dh) / 2;
    }

    gpVideo.style.width  = `${dw}px`;
    gpVideo.style.height = `${dh}px`;
    gpVideo.style.left   = `${cx}px`;
    gpVideo.style.top    = `${cy}px`;
  }

  if (gpHold && gpVideo) {
    gpVideo.style.position = 'absolute';

    function createBgVideo() {
      if (gpHold.querySelector('.bg_video') || !gpVideo.src) return;
      const bg = document.createElement('video');
      bg.className = 'bg_video';
      bg.src       = gpVideo.src;
      bg.muted     = true;
      bg.setAttribute('playsinline', '');
      bg.preload   = 'auto';
      Object.assign(bg.style, {
        position:      'absolute',
        inset:         '0',
        width:         '100%',
        height:        '100%',
        objectFit:     'cover',
        filter:        'blur(20px)',
        transform:     'scale(1.1)',
        zIndex:        '0',
        pointerEvents: 'none',
      });
      const sourceEmbed = gpHold.querySelector('.source_embed');
      gpHold.insertBefore(bg, sourceEmbed);
      bg.currentTime = gpVideo.currentTime;
      bg.load();
      gpVideo.addEventListener('play',   () => bg.play().catch(() => {}));
      gpVideo.addEventListener('pause',  () => bg.pause());
      gpVideo.addEventListener('seeked', () => { bg.currentTime = gpVideo.currentTime; });
    }

    gpVideo.addEventListener('loadedmetadata', () => {
      createBgVideo();
      applyGpZoom(gpZoom);
    });
    if (gpVideo.readyState >= 1) createBgVideo();

    applyGpZoom(1);

    makeDraggable(gpHold, {
      target:  gpVideo,
      getScale,
      clamp: (x, y) => {
        const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
        const dw = gpVideo.offsetWidth, dh = gpVideo.offsetHeight;
        const cx = dw <= hw ? (hw - dw) / 2 : Math.max(hw - dw, Math.min(0, x));
        const cy = dh <= hh ? (hh - dh) / 2 : Math.max(hh - dh, Math.min(0, y));
        return [cx, cy];
      },
    });

    gpHold.addEventListener('wheel', e => {
      e.preventDefault();
      applyGpZoom(gpZoom + (e.deltaY > 0 ? -1 : 1) * ZOOM_STEP);
    }, { passive: false });
  }

  // ── Track state ──────────────────────────────────────────────────────────
  const tracks = {
    video: { trimIn: 0, trimOut: 0 },
    title: { start: 0, end: null },   // null = plays until clip end
    image: { start: 0, end: null },
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
  }

  // Master window playback enforcement
  gpVideo.addEventListener('timeupdate', () => {
    const { effectiveStart, effectiveEnd, duration } = getTrackBounds();
    const t = gpVideo.currentTime;
  
    // Master trim enforcement
    if (isFinite(effectiveEnd) && effectiveEnd > effectiveStart) {
      if (t < effectiveStart) {
        gpVideo.currentTime = effectiveStart;
      } else if (t >= effectiveEnd) {
        gpVideo.pause();
        gpVideo.currentTime = effectiveStart;
      }
    }
  
    // Secondary track visibility — only when user hasn't explicitly hidden
    if (titleHold?._userVisible !== false) {
      const inTitle = t >= (tracks.title.start ?? 0)
                   && t <= (tracks.title.end   ?? duration);
      titleHold.style.visibility = inTitle ? '' : 'hidden';
    }
    if (imgHold?._userVisible !== false) {
      const inImage = t >= (tracks.image.start ?? 0)
                   && t <= (tracks.image.end   ?? duration);
      imgHold.style.visibility = inImage ? '' : 'hidden';
    }
  });

  // ── Facecam overlay drag ─────────────────────────────────────────────────
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

    let ox = 0, oy = 0, sx = 0, sy = 0, dragLive = false;

    function onDown(e) {
      if (e.target.classList.contains('resize_handle')) return;
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
      ;[nx, ny] = clampHoldInFrame(nx, ny, fcHold, frame);
      fcHold.style.left = `${nx}px`;
      fcHold.style.top  = `${ny}px`;
    }
    function onUp() {
      if (!dragLive) return;
      dragLive = false;
      fcHold.style.cursor = 'grab';
    }

    fcHold.addEventListener('pointerdown',   onDown);
    fcHold.addEventListener('pointermove',   onMove);
    fcHold.addEventListener('pointerup',     onUp);
    fcHold.addEventListener('pointercancel', onUp);

    const handle = document.createElement('div');
    handle.className = 'resize_handle';
    Object.assign(handle.style, {
      position: 'absolute', bottom: '0', right: '0',
      width: '18px', height: '18px', cursor: 'se-resize',
      background: 'rgba(255,255,255,0.3)', borderRadius: '4px 0 0 0',
      zIndex: '10', touchAction: 'none',
    });
    fcHold.appendChild(handle);

    const minW = 60, minH = 60;
    let startX, startY, startW, startH, resizeLive = false;

    function onResizeDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault(); e.stopPropagation();
      startX = e.clientX / getScale(); startY = e.clientY / getScale();
      startW = fcHold.offsetWidth;     startH = fcHold.offsetHeight;
      resizeLive = true;
      handle.setPointerCapture(e.pointerId);
    }
    function onResizeMove(e) {
      if (!resizeLive) return;
      const maxW = frame.clientWidth  - (parseFloat(fcHold.style.left) || 0);
      const maxH = frame.clientHeight - (parseFloat(fcHold.style.top)  || 0);
      fcHold.style.width  = `${Math.max(minW, Math.min(maxW, startW + e.clientX / getScale() - startX))}px`;
      fcHold.style.height = `${Math.max(minH, Math.min(maxH, startH + e.clientY / getScale() - startY))}px`;
    }
    function onResizeUp() { resizeLive = false; }

    handle.addEventListener('pointerdown',   onResizeDown);
    handle.addEventListener('pointermove',   onResizeMove);
    handle.addEventListener('pointerup',     onResizeUp);
    handle.addEventListener('pointercancel', onResizeUp);

    fcDragCleanup = () => {
      fcHold.removeEventListener('pointerdown',   onDown);
      fcHold.removeEventListener('pointermove',   onMove);
      fcHold.removeEventListener('pointerup',     onUp);
      fcHold.removeEventListener('pointercancel', onUp);
      handle.remove();
      fcHold.style.cursor = '';
      fcDragBound = false;
    };
  }

  function unbindFcDrag() { fcDragCleanup?.(); fcDragCleanup = null; }

  // ── Split handle ─────────────────────────────────────────────────────────
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
      applyGpZoom(gpZoom);
    };

    let live = false, startY = 0, startPct = 0;
    splitHandle.style.cursor = 'ns-resize';

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

    window.setSplitPct = pct => applySplit(pct);
  }

  // ── Overlay holds ────────────────────────────────────────────────────────
  if (imgHold)  makeOverlayInteractive(imgHold,  frame, getScale);
  if (chatHold) makeOverlayInteractive(chatHold, frame, getScale);

  // ── Selection ────────────────────────────────────────────────────────────
  const allHolds = [gpHold, fcHold, titleHold, subHold, imgHold, chatHold].filter(Boolean);
  bindSelection(frame, allHolds);

  // ── Mode API ─────────────────────────────────────────────────────────────
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
    applyMode(mode, {
      ...modeRefs,
      hasFacecam:   item._cropValid    ?? false,
      hasChatSplit: item._hasChatSplit ?? false,
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
    // ── Track system ──
    tracks,
    getTrackBounds,
    clampSecondaryTracks,
  });

  window.setLayoutMode = applyModeFn;

} // END initCanvas

// ─────────────────────────────────────────────────────────────────────────────
// 16. DATA RE-APPLY
// ─────────────────────────────────────────────────────────────────────────────
function reapplyCrop(item) {
  const gpVideo   = item.querySelector('[wized="stream_clip_video"]');
  const fcHold    = item.querySelector('.facecam_hold');
  const chatHold  = item.querySelector('.chat_hold');
  const titleHold = item.querySelector('.title_hold');

  // Title
  const titleStr = item.querySelector('[wized="stream_clip_title-list"]')?.textContent.trim();
  if (titleStr && titleStr !== item._lastRenderedTitle) {
    item._lastRenderedTitle = titleStr;
    if (titleHold.clientWidth > 0) {
      renderTitlePills(titleHold, titleStr);
    } else {
      requestAnimationFrame(() => renderTitlePills(titleHold, titleStr));
    }
  }

  // Image overlay — only set src here, visibility/scale/position owned by persistence
  const imageUrl = item.querySelector('[wized="stream_clip_image_url"]')?.textContent.trim();
  if (imageUrl) {
    const clipId   = item.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
    const hasSaved = !!localStorage.getItem(`canvas_state_${clipId}`);
    window.canvasAPI?.setImage(imageUrl);
    if (!hasSaved) {
      window.canvasAPI?.setImageScale(0.25);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.canvasAPI?.setImagePosition(0.5, 0.3);
          window.canvasAPI?.setImageVisible(true);
          document.querySelector('[wized="toggle_image_overlay"]')?.classList.add('is-active');
        });
      });
    }
  }

  // Transcript
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

  // Chat video
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
        width:         '100%',
        height:        '100%',
        objectFit:     'cover',
        display:       'block',
        pointerEvents: 'none',
        mixBlendMode:  'screen',
      });
      chatHold.insertBefore(vid, chatHold.firstChild);
      vid.addEventListener('loadedmetadata', () => {
        vid.currentTime = gpVideo.currentTime;
      }, { once: true });
      gpVideo.addEventListener('play',   () => vid.play().catch(() => {}));
      gpVideo.addEventListener('pause',  () => vid.pause());
      gpVideo.addEventListener('ended',  () => vid.pause());
      gpVideo.addEventListener('seeked', () => { vid.currentTime = gpVideo.currentTime; });
      vid.load();
    }
  }

  // Facecam crop
  if (!gpVideo || !fcHold) return;

  const hasCrop = item.querySelector('[wized="stream_clip_contains_facecam"]')?.textContent.trim().toLowerCase() === 'true';
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
    if (!wasValid) item._applyMode?.('is-split');
  } else {
    // ── FIXED: chat-only clips default to is-split, others to is-full ──────
    if (wasValid !== false) {
      item._applyMode?.(item._hasChatSplit ? 'is-split' : 'is-full');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. BOOT
// ─────────────────────────────────────────────────────────────────────────────
function bootCanvas() {
  const item = document.querySelector('#clip_item');
  if (item) {
    if (!item.dataset.canvasInit) {
      item.dataset.canvasInit = '1';
      initCanvas(item, { interactive: true });
    }
    reapplyCrop(item);
    requestAnimationFrame(() => window.syncPanelUI?.());
  }
  document.querySelectorAll('.clip_item:not([data-canvas-init])').forEach(el => {
    el.dataset.canvasInit = '1';
    initCanvas(el, { interactive: false });
  });
}

window.bootCanvas = bootCanvas;

window.Wized = window.Wized || [];
window.Wized.push(wized => {
  wized.on('requestEnd', bootCanvas);
});
bootCanvas();

})();
