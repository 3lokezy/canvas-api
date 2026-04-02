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

      if (resizable && !hold.querySelector('[data-overlay-handle]')) {
        const dot = document.createElement('div');
        dot.dataset.overlayHandle = 'se';
        Object.assign(dot.style, {
          position: 'absolute', bottom: '-5px', right: '-5px',
          width: '10px', height: '10px', cursor: 'se-resize',
          background: '#fff', border: '1.5px solid rgba(0,0,0,0.25)',
          borderRadius: '50%', zIndex: '10', touchAction: 'none',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          opacity: '0', transition: 'opacity .15s',
        });
        hold.appendChild(dot);

        hold.addEventListener('pointerenter', () => { dot.style.opacity = '1'; });
        hold.addEventListener('pointerleave', () => { if (!resizeLive) dot.style.opacity = '0'; });

        let startX, startY, startW, startH, resizeLive = false;

        dot.addEventListener('pointerdown', e => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          e.preventDefault(); e.stopPropagation();
          startX = e.clientX / getScale(); startY = e.clientY / getScale();
          startW = hold.offsetWidth; startH = hold.offsetHeight;
          const img = hold.querySelector('img');
          hold._aspectRatio = (img?.naturalWidth && img?.naturalHeight)
            ? img.naturalWidth / img.naturalHeight : null;
          resizeLive = true;
          dot.setPointerCapture(e.pointerId);
        });

        dot.addEventListener('pointermove', e => {
          if (!resizeLive) return;
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

        const endResize = () => { resizeLive = false; dot.style.opacity = '0'; };
        dot.addEventListener('pointerup',     endResize);
        dot.addEventListener('pointercancel', endResize);
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
        subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => {
          p.style.visibility = 'hidden';
          p.classList.remove('is-active');
        });
        lastWordIdx = -2;
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
            subHold.querySelectorAll('.subtitle_pill[data-chunk]').forEach(p => p.classList.remove('is-active'));
            lastWordIdx = -1;
          } else {
            hideAll();
          }
        }
      });
    
      video.addEventListener('seeked', () => { hideAll(); lastChunkIdx = -2; });
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

      document.addEventListener('pointerdown', e => {
        if (frame.contains(e.target)) return;
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
    
    // ─────────────────────────────────────────────────────────────────────────────
    // PASSIVE STATE APPLY
    // ─────────────────────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────────────────────
    // DEFAULT ZOOM — shared formula, correct aspect ratio via cover scale
    // ─────────────────────────────────────────────────────────────────────────────
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
    
      // Apply default zoom only for split — full/overlay are handled in applyModeFn
      // after per-mode state restore, and in loadedmetadata for first load
      requestAnimationFrame(() => {
        if (safeMode === 'is-split') applyGpZoom(1);
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
        tracks, getTrackBounds, clampSecondaryTracks,
        modeStates,
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
    
        // ── Gameplay — save mode state after every zoom/pan change ───────────────
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
        pause()      { gpVideo?.pause(); },
        seekTo(secs) { if (gpVideo) gpVideo.currentTime = secs; },
    
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
          const safeIn     = Math.max(0, Math.min(trimIn,  duration));
          const safeOut    = Math.max(0, Math.min(trimOut, duration - safeIn));
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
        },
    
        getTrackBounds() { return getTrackBounds(); },
        getTracks()      { return JSON.parse(JSON.stringify(tracks)); },
    
        // ── Per-mode state — loaded by persistence before setMode ────────────────
        setModeStates(states) {
          Object.keys(states).forEach(mode => {
            if (modeStates[mode] !== undefined) {
              modeStates[mode] = { ...modeStates[mode], ...states[mode] };
            }
          });
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
            playing:    gpVideo ? !gpVideo.paused : false,
            tracks:     JSON.parse(JSON.stringify(tracks)),
            modeStates: JSON.parse(JSON.stringify(modeStates)),
          };
        },

      };

      const tlBtn = document.getElementById('timeline_play_button');
      if (tlBtn) {
        tlBtn.addEventListener('click', () => { gpVideo.paused ? gpVideo.play().catch(() => {}) : gpVideo.pause(); });
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
      let _prevFrameW  = frame.clientWidth   || 1;
      let _prevFrameH  = frame.clientHeight  || 1;
      let _prevGpHoldW = gpHold?.clientWidth  || 1;
      let _prevGpHoldH = gpHold?.clientHeight || 1;

      const ro = new ResizeObserver(() => {
        scaleFrame(frame);

        const newW = frame.clientWidth, newH = frame.clientHeight;
        if (newW && newH && (_prevFrameW !== newW || _prevFrameH !== newH)) {
          const rW = newW / _prevFrameW;

          // ── Overlays: scale everything by width ratio (matches cqw) ────────
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

          // ── Gameplay: re-layout video with pan preservation ────────────────
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
      if (imgHold) {
        imgHold.style.visibility = 'hidden';
        imgHold.style.position   = 'absolute';
        imgHold.style.left       = '0';
        imgHold.style.top        = '0';
      }
    
      bindControls(item, gpVideo);
      requestAnimationFrame(() => applyTextZones(textGroup, 'top', 'bottom'));
    
      // ── Passive mode ─────────────────────────────────────────────────────────
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
    
      // ── Per-mode zoom/pan state
      // Owned entirely by canvasAPI — updated via setGameplayZoom and pan drag end
      // is-split has no zoom state (always locked to 1)
      const modeStates = {
        'is-full':    { zoom: null, panX: null, panY: null },
        'is-split':   {},
        'is-overlay': { zoom: null, panX: null, panY: null },
      };
    
      // ── Gameplay zoom ─────────────────────────────────────────────────────────
      let gpZoom = 1;
    
      function applyGpZoom(zoom) {
        const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
        const vw = gpVideo.videoWidth  || hw;
        const vh = gpVideo.videoHeight || hh;
        if (!hw || !hh) return;
    
        // Cover scale: ensures video always fills the hold correctly
        const coverScale = Math.max(hw / vw, hh / vh);
        const zoomMin    = frame._currentMode === 'is-split'
          ? 1
          : Math.max(0.2, (hw / vw) / coverScale);
    
        gpZoom = Math.min(ZOOM_MAX, Math.max(zoomMin, parseFloat(zoom.toFixed(3))));
        const dw = vw * coverScale * gpZoom;
        const dh = vh * coverScale * gpZoom;
    
        // Preserve pan proportionally on zoom change
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
    
        if (oldDw > 0 && hasPan) {
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
      }
    
      // Restore a mode's saved zoom + pan — waits for video dimensions if needed
      function restoreModeZoomPan(mode) {
        const saved = modeStates[mode];
        if (!saved?.zoom) return false;
      
        const doRestore = () => {
          const hw = gpHold.clientWidth,  hh = gpHold.clientHeight;
          const vw = gpVideo.videoWidth,  vh = gpVideo.videoHeight;
          if (!vw || !vh || !hw || !hh) return;
      
          // Compute correct dimensions directly — bypasses pan-preservation in applyGpZoom
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
    
        // Placeholder before video loads — cover with no distortion
        Object.assign(gpVideo.style, { width: '100%', height: '100%', left: '0', top: '0' });
        gpVideo.style.setProperty('object-fit', 'cover', 'important');
    
        function createBgVideo() {
          if (gpHold.querySelector('.bg_video') || !gpVideo.src) return;
          const bg = document.createElement('video');
          bg.className = 'bg_video';
          bg.src       = gpVideo.src;
          bg.muted     = true;
          bg.setAttribute('playsinline', '');
          bg.preload   = 'auto';
          Object.assign(bg.style, {
            position: 'absolute', inset: '0',
            width: '100%', height: '100%',
            objectFit: 'cover', filter: 'blur(20px)',
            transform: 'scale(1.1)', zIndex: '0',
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
            // Clear all placeholder styles so applyGpZoom starts from a clean state
            gpVideo.style.removeProperty('object-fit');
            gpVideo.style.removeProperty('width');
            gpVideo.style.removeProperty('height');
            gpVideo.style.removeProperty('left');
            gpVideo.style.removeProperty('top');
    
          const mode  = frame._currentMode ?? 'is-full';
          const saved = modeStates[mode];
    
          if (saved?.zoom) {
            // Restore saved per-mode state
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
            // First load — apply correct default zoom using real aspect ratio
            const defaultZoom = calcDefaultZoom(gpHold, gpVideo);
            if (defaultZoom !== null) applyGpZoom(defaultZoom);
          } else {
            applyGpZoom(1);
          }
    
          const { effectiveStart } = getTrackBounds();
          if (effectiveStart > 0) gpVideo.currentTime = effectiveStart;
        });
    
        if (gpVideo.readyState >= 1) createBgVideo();
    
        // Pan drag — save mode state on drag end
        makeDraggable(gpHold, {
          target: gpVideo,
          getScale,
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
            }
          },
        });
    
        gpHold.addEventListener('wheel', e => {
          e.preventDefault();
          const newZoom = gpZoom + (e.deltaY > 0 ? -1 : 1) * ZOOM_STEP;
          applyGpZoom(newZoom);
          // Save via API to keep state consistent
          window.canvasAPI?.setGameplayZoom(gpZoom);
        }, { passive: false });
      }
    
      // ── Track state ──────────────────────────────────────────────────────────
      const tracks = {
        video: { trimIn: 0, trimOut: 0 },
        title: { start: 0, end: null },
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
    
      // ── Master window playback enforcement ───────────────────────────────────
      let _loopPending = false;

      gpVideo.addEventListener('timeupdate', () => {
        if (!interactive || frame._rendering) return;
        if (gpVideo.seeking || _loopPending) return;
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

      // Fallback loop for natural-end: 'ended' pauses the video before
      // timeupdate can catch effectiveEnd, so we need explicit seek + play
      gpVideo.addEventListener('ended', () => {
        if (!interactive || _loopPending || frame._rendering) return;
        const { effectiveStart, effectiveEnd } = getTrackBounds();
        if (!isFinite(effectiveEnd) || effectiveEnd <= effectiveStart) return;
        _loopPending = true;
        gpVideo.currentTime = effectiveStart;
        gpVideo.addEventListener('seeked', () => {
          _loopPending = false;
          gpVideo.play().catch(() => {});
        }, { once: true });
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

        const dot = document.createElement('div');
        dot.dataset.overlayHandle = 'se';
        Object.assign(dot.style, {
          position: 'absolute', bottom: '-5px', right: '-5px',
          width: '10px', height: '10px', cursor: 'se-resize',
          background: '#fff', border: '1.5px solid rgba(0,0,0,0.25)',
          borderRadius: '50%', zIndex: '10', touchAction: 'none',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          opacity: '0', transition: 'opacity .15s',
        });
        fcHold.appendChild(dot);
        fcHold.addEventListener('pointerenter', () => { dot.style.opacity = '1'; });
        fcHold.addEventListener('pointerleave', () => { if (!resizeLive) dot.style.opacity = '0'; });

        const minW = 60, minH = 60;
        let startX, startY, startW, startH, resizeLive = false;

        function onResizeDown(e) {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          e.preventDefault(); e.stopPropagation();
          startX = e.clientX / getScale(); startY = e.clientY / getScale();
          startW = fcHold.offsetWidth; startH = fcHold.offsetHeight;
          resizeLive = true;
          dot.setPointerCapture(e.pointerId);
        }
        function onResizeMove(e) {
          if (!resizeLive) return;
          const maxW = frame.clientWidth  - (parseFloat(fcHold.style.left) || 0);
          const maxH = frame.clientHeight - (parseFloat(fcHold.style.top)  || 0);
          fcHold.style.width  = `${Math.max(minW, Math.min(maxW, startW + e.clientX / getScale() - startX))}px`;
          fcHold.style.height = `${Math.max(minH, Math.min(maxH, startH + e.clientY / getScale() - startY))}px`;
        }
        function onResizeUp() { resizeLive = false; dot.style.opacity = '0'; }

        dot.addEventListener('pointerdown',   onResizeDown);
        dot.addEventListener('pointermove',   onResizeMove);
        dot.addEventListener('pointerup',     onResizeUp);
        dot.addEventListener('pointercancel', onResizeUp);

        fcDragCleanup = () => {
          fcHold.removeEventListener('pointerdown',   onDown);
          fcHold.removeEventListener('pointermove',   onMove);
          fcHold.removeEventListener('pointerup',     onUp);
          fcHold.removeEventListener('pointercancel', onUp);
          dot.remove();
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
    
        window.setSplitPct = pct => {
          if (frame._currentMode === 'is-split') {
            applySplit(pct);
          } else {
            splitPct = Math.max(0.1, Math.min(0.9, pct));
          }
          modeStates['is-split'] = { splitPct: splitPct };
        };
      }
    
      if (imgHold)  makeOverlayInteractive(imgHold,  frame, getScale);
      if (chatHold) makeOverlayInteractive(chatHold, frame, getScale);
    
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
        const leavingMode = frame._currentMode;

        // Save current mode's state before leaving
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

        // Restore splitPct before applyMode uses it
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

        // Restore facecam overlay position/size when entering overlay
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

        // Restore gameplay zoom/pan for the entering mode
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
      const clipFrame = item.querySelector('.clip_canvas');
      const gpHold    = item.querySelector('.gameplay_hold');
    
      // ── Title ─────────────────────────────────────────────────────────────────
      const titleStr = item.querySelector('[wized="stream_clip_title-list"]')?.textContent.trim();
      if (titleStr && titleStr !== item._lastRenderedTitle) {
        item._lastRenderedTitle = titleStr;
        if (titleHold?.clientWidth > 0) {
          renderTitlePills(titleHold, titleStr);
        } else {
          requestAnimationFrame(() => renderTitlePills(titleHold, titleStr));
        }
      }
    
      // ── Image overlay ─────────────────────────────────────────────────────────
      const imageUrl = item.querySelector('[wized="stream_clip_image_url"]')?.textContent.trim();
      if (imageUrl) {
        const clipId   = item.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
        const hasSaved = !!localStorage.getItem(`canvas_state_${clipId}`);
        window.canvasAPI?.setImage(imageUrl);
        if (!hasSaved) {
          if (window.canvasAPI) {
            window.canvasAPI.setImageScale(0.25);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              window.canvasAPI.setImagePosition(0.5, 0.3);
              window.canvasAPI.setImageVisible(true);
              document.querySelector('[wized="toggle_image_overlay"]')?.classList.add('is-active');
            }));
          } else {
            const imgHold = item.querySelector('.image_hold');
            if (imgHold) imgHold.style.visibility = '';
          }
        }
      }
    
      // ── Transcript ────────────────────────────────────────────────────────────
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
    
      // ── Chat video ────────────────────────────────────────────────────────────
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
          gpVideo.addEventListener('seeked', () => { vid.currentTime = gpVideo.currentTime; });
          vid.load();
        }
      }
    
      // ── Passive first frame render ────────────────────────────────────────────
      if (!item._applyMode && gpVideo) {
        if (gpVideo.readyState >= 2) {
          gpVideo.currentTime = 0.1;
        } else {
          gpVideo.addEventListener('loadeddata', () => {
            gpVideo.currentTime = 0.1;
          }, { once: true });
        }
      }
    
      // ── Facecam crop ──────────────────────────────────────────────────────────
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
    
      // ── Apply Supabase canvas state to passive render — must be last ──────────
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
    
    // ─────────────────────────────────────────────────────────────────────────────
    // 17. BOOT
    // ─────────────────────────────────────────────────────────────────────────────
    function bootCanvas() {
      document.querySelectorAll('[data-canvas="interactive"]').forEach(item => {
        if (!item.dataset.canvasInit) {
          item.dataset.canvasInit = '1';
          initCanvas(item, { interactive: true });
        }
        reapplyCrop(item);

        // Watch Wized data divs for late DOM updates (Wized may hydrate
        // after requestEnd fires). Debounced to avoid rapid re-runs.
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