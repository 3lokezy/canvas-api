(function () {
  'use strict';

  const DRAG_THRESHOLD = 4;
  const SNAP_THRESHOLD = 0.3;
  const NUDGE_FRAMES = 1 / 30;

  let _timelineCleanup = null;

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  function pxToSec(px, rowW, duration) {
    return (px / rowW) * duration;
  }

  function snap(sec, api, gpVideo, duration, excludeName) {
    const targets = [gpVideo.currentTime];
    const t = api.getTracks();
    Object.entries(t).forEach(([name, track]) => {
      if (name === excludeName) return;
      if (name === 'video') {
        targets.push(t.video.trimIn);
        targets.push(duration - t.video.trimOut);
      } else {
        targets.push(track.start ?? 0);
        targets.push(track.end ?? duration);
      }
    });
    let closest = null;
    let closestDist = SNAP_THRESHOLD;
    targets.forEach((target) => {
      const dist = Math.abs(sec - target);
      if (dist < closestDist) {
        closest = target;
        closestDist = dist;
      }
    });
    return closest !== null ? closest : sec;
  }

  function updateOffsetInner(parent, inner, offset, musicDuration, windowLength) {
    if (!parent || !inner || !windowLength) return;
    const ratio = musicDuration / windowLength;
    const parentW = parent.clientWidth;
    const innerW = ratio * parentW;
    const maxPx = Math.max(0, innerW - parentW);
    const pct = musicDuration > 0 ? offset / musicDuration : 0;
    inner.style.position = 'absolute';
    inner.style.width = `${ratio * 100}%`;
    inner.style.left = `${-(pct * maxPx)}px`;
  }

  function bindOffsetDrag(row, api, ac, duration) {
    const dragParent = row.querySelector('.track-offset-drag');
    const dragInner = row.querySelector('.track-offset-inner');
    if (!dragParent || !dragInner) return null;

    function getWindowLength() {
      const t = api.getTracks().music;
      return (t.end ?? duration) - (t.start ?? 0);
    }

    function updateInner() {
      const windowLength = getWindowLength();
      const musicDur = api.getMusicDuration();
      updateOffsetInner(dragParent, dragInner, api.getMusicOffset(), musicDur, windowLength);
      dragInner.style.cursor = musicDur > windowLength ? 'grab' : '';
    }

    updateInner();

    let live = false;
    let startX = 0;
    let startOffset = 0;

    dragInner.addEventListener(
      'pointerdown',
      (e) => {
        if (api.getMusicDuration() <= getWindowLength()) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        e.stopPropagation();
        live = true;
        startX = e.clientX;
        startOffset = api.getMusicOffset();
        dragInner.setPointerCapture(e.pointerId);
        dragInner.style.cursor = 'grabbing';
      },
      { signal: ac.signal },
    );

    dragInner.addEventListener(
      'pointermove',
      (e) => {
        if (!live) return;
        const musicDur = api.getMusicDuration();
        const windowLen = getWindowLength();
        const parentW = dragParent.clientWidth;
        const innerW = (musicDur / windowLen) * parentW;
        const maxPx = Math.max(1, innerW - parentW);
        const dSec = ((e.clientX - startX) / maxPx) * musicDur;
        const maxOffset = Math.max(0, musicDur - windowLen);
        const newOffset = Math.max(0, Math.min(maxOffset, startOffset - dSec));
        api.setMusicOffset(newOffset);
        updateOffsetInner(dragParent, dragInner, newOffset, musicDur, windowLen);
      },
      { signal: ac.signal },
    );

    const end = () => {
      if (!live) return;
      live = false;
      dragInner.style.cursor = api.getMusicDuration() > getWindowLength() ? 'grab' : '';
    };
    dragInner.addEventListener('pointerup', end, { signal: ac.signal });
    dragInner.addEventListener('pointercancel', end, { signal: ac.signal });

    return updateInner;
  }

  // A transparent overlay on top of every clip/track block, purely for interaction
  // styling. pointer-events:none → never blocks the bar's hover/drag/handles. Style
  // it in Webflow via the parent state classes, e.g.:
  //   .track-active.is-hovered  .clip_state { background: rgba(255,255,255,.08); }
  //   .track-active.is-selected .clip_state { box-shadow: inset 0 0 0 2px #4da3ff; }
  //   .track-active.is-delete-target .clip_state { background: rgba(255,60,60,.28); }
  // Default (visible) state styling, injected once. Prepended to <head> so any
  // Webflow rule for `.clip_state` overrides it at equal specificity.
  (function injectStateCSS() {
    if (document.getElementById('nle-state-css')) return;
    const s = document.createElement('style');
    s.id = 'nle-state-css';
    s.textContent =
      '.track-active.is-hovered .clip_state{background:rgba(255,255,255,.18);box-shadow:inset 0 0 0 2px rgba(255,255,255,.6);}' +
      '.track-active.is-selected .clip_state{box-shadow:inset 0 0 0 3px #4da3ff;}' +
      '.track-active.is-dragging .clip_state{background:rgba(255,255,255,.24);}' +
      '.track-active.is-delete-target .clip_state{background:rgba(255,60,60,.40);box-shadow:inset 0 0 0 2px #ff3c3c;}';
    (document.head || document.documentElement).insertBefore(s, (document.head || document.documentElement).firstChild);
  })();

  function _ensureStateOverlay(el) {
    // the overlay is absolutely positioned → the bar must be a positioned ancestor
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    let o = el.querySelector(':scope > .clip_state');
    if (!o) {
      o = document.createElement('div');
      o.className = 'clip_state';
      o.style.cssText = 'position:absolute;inset:0;pointer-events:none;border-radius:inherit;z-index:9999;';
      el.appendChild(o);
    }
    return o;
  }

  // Exclusive selection across ALL tracks (clip bars + image/title/music blocks).
  function _selectActive(el) {
    document.querySelectorAll('[data-track] .track-active.is-selected')
      .forEach(x => { if (x !== el) x.classList.remove('is-selected'); });
    if (el) el.classList.add('is-selected');
  }

  function bindTrackRow(row, api, gpVideo, fullDuration, getWindowOffset, getDisplayDuration, ac) {
    const name = row.dataset.track;
    const isMaster = name === 'video';
    const active = row.querySelector('.track-active');
    if (!active) return null;
    _ensureStateOverlay(active);

    // Interaction state classes — same system as the clip track (styled in Webflow).
    // (No is-delete-target here: delete only acts on clip bars, so a red tint on
    // image/title/music would be misleading until a delete action exists for them.)
    active.addEventListener('pointerenter', () => active.classList.add('is-hovered'), { signal: ac.signal });
    active.addEventListener('pointerleave', () => active.classList.remove('is-hovered'), { signal: ac.signal });

    const handles = Array.from(row.querySelectorAll('.track-handle'));
    const hL = handles[0] ?? null;
    const hR = handles[1] ?? null;

    function getWindow() {
      const t = api.getTracks();
      if (isMaster) {
        return { start: t.video.trimIn, end: fullDuration - t.video.trimOut };
      }
      return { start: t[name]?.start ?? 0, end: t[name]?.end ?? fullDuration };
    }
    let _updateOffsetInner = null;

    function update() {
      const totalW = row.clientWidth;
      const windowOffset = getWindowOffset();
      const duration = getDisplayDuration();
      if (!totalW || !duration) return;
      const { start, end } = getWindow();
      const leftPct = ((start - windowOffset) / duration) * 100;
      const widthPct = ((end - start) / duration) * 100;
      active.style.left = `${leftPct}%`;
      active.style.width = `${Math.max(0, widthPct)}%`;
      _updateOffsetInner?.();
    }

    function applyWindow(start, end) {
      if (isMaster) {
        api.setMasterTrim(start, duration - end);
      } else {
        api.setTrack(name, { start, end });
      }
    }

    function bindHandle(handle, side) {
      if (!handle) return;
      let live = false;
      let startX = 0;
      let startSec = 0;

      handle.addEventListener(
        'pointerdown',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          live = true;
          startX = e.clientX;
          startSec = side === 'left' ? getWindow().start : getWindow().end;
          handle.setPointerCapture(e.pointerId);
        },
        { signal: ac.signal },
      );

      handle.addEventListener(
        'pointermove',
        (e) => {
          if (!live) return;
          const totalW = row.clientWidth;
          const windowOffset = getWindowOffset();
          const duration = getDisplayDuration();
          const dSec = pxToSec(e.clientX - startX, totalW, duration);
          const rawSec = startSec + dSec;
          const clampedSec = Math.max(windowOffset, Math.min(windowOffset + duration, rawSec));
          const snapped = snap(clampedSec, api, gpVideo, fullDuration, name);
          const w = getWindow();
          if (isMaster) {
            const t = api.getTracks().video;
            if (side === 'left') api.setMasterTrim(snapped, t.trimOut);
            else api.setMasterTrim(t.trimIn, fullDuration - snapped);
          } else if (side === 'left') {
            api.setTrack(name, { start: snapped, end: w.end });
          } else {
            api.setTrack(name, { start: w.start, end: snapped });
          }
          update();
        },
        { signal: ac.signal },
      );

      const end = () => {
        live = false;
      };
      handle.addEventListener('pointerup', end, { signal: ac.signal });
      handle.addEventListener('pointercancel', end, { signal: ac.signal });
    }

    bindHandle(hL, 'left');
    bindHandle(hR, 'right');

    if (name === 'music') _updateOffsetInner = bindOffsetDrag(row, api, ac, fullDuration);

    let dragState = 'idle';
    let pendingStartX = 0;
    let dragStartX = 0;
    let dragStartW = null;

    active.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target.classList.contains('track-handle')) return;
        if (e.target.classList.contains('track-offset-inner') && api.getMusicDuration() > getWindow().end - getWindow().start) return;
        if (e.target.classList.contains('track-offset-drag') && api.getMusicDuration() > getWindow().end - getWindow().start) return;
        e.preventDefault();
        e.stopPropagation();
        dragState = 'pending';
        pendingStartX = e.clientX;
        dragStartX = e.clientX;
        dragStartW = { ...getWindow() };
        active.setPointerCapture(e.pointerId);
        active.style.cursor = 'grab';
      },
      { signal: ac.signal },
    );

    active.addEventListener(
      'pointermove',
      (e) => {
        if (dragState === 'idle') return;
        const moved = Math.abs(e.clientX - pendingStartX);
        if (dragState === 'pending' && moved >= DRAG_THRESHOLD) {
          dragState = 'dragging';
          active.style.cursor = 'grabbing';
          active.classList.add('is-dragging');
        }
        if (dragState === 'dragging') {
          const totalW = row.clientWidth;
          const duration = getDisplayDuration();
          const dSec = pxToSec(e.clientX - dragStartX, totalW, duration);
          const winLen = dragStartW.end - dragStartW.start;
          const { effectiveStart, effectiveEnd } = api.getTrackBounds();
          let newStart = dragStartW.start + dSec;
          let newEnd = newStart + winLen;
          if (newStart < effectiveStart) {
            newStart = effectiveStart;
            newEnd = newStart + winLen;
          }
          if (newEnd > effectiveEnd) {
            newEnd = effectiveEnd;
            newStart = newEnd - winLen;
          }
          const snappedStart = snap(newStart, api, gpVideo, fullDuration, name);
          const snappedEnd = snap(newEnd, api, gpVideo, fullDuration, name);
          const snapDeltaStart = Math.abs(snappedStart - newStart);
          const snapDeltaEnd = Math.abs(snappedEnd - newEnd);
          if (snapDeltaStart <= snapDeltaEnd && snapDeltaStart < SNAP_THRESHOLD) {
            newStart = snappedStart;
            newEnd = newStart + winLen;
          } else if (snapDeltaEnd < SNAP_THRESHOLD) {
            newEnd = snappedEnd;
            newStart = newEnd - winLen;
          }
          applyWindow(newStart, newEnd);
          update();
        }
      },
      { signal: ac.signal },
    );

    active.addEventListener(
      'pointerup',
      (e) => {
        if (dragState === 'pending') {
          const rx      = e.clientX - active.getBoundingClientRect().left;
          const isNLE   = api.getClips?.()?.length > 0;
          if (isNLE) {
            const outputDur = api.getOutputDuration?.() ?? 0;
            const tlDur = api._nleTimelineDuration ?? outputDur;
            if (outputDur > 0) {
              const ot = Math.max(0, Math.min(outputDur, (rx / active.offsetWidth) * tlDur));
              api.seekToOutputTime?.(ot);
            }
          } else {
            const { start, end } = getWindow();
            const sec = start + Math.max(0, Math.min(1, rx / active.offsetWidth)) * (end - start);
            api.seekTo(sec);
          }
          _selectActive(active);   // clean click → select this track block
        }
        dragState = 'idle';
        active.style.cursor = '';
        active.classList.remove('is-dragging');
      },
      { signal: ac.signal },
    );

    active.addEventListener(
      'pointercancel',
      () => {
        dragState = 'idle';
        active.style.cursor = '';
        active.classList.remove('is-dragging');
      },
      { signal: ac.signal },
    );

    row.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== row) return;
        if (row._nleReady) return;
        const rx = e.clientX - row.getBoundingClientRect().left;
        const isNLE = api.getClips?.()?.length > 0;
        if (isNLE) {
          const outputDur = api.getOutputDuration?.() ?? 0;
          const tlDur = api._nleTimelineDuration ?? outputDur;
          if (outputDur > 0) {
            const ot = Math.max(0, Math.min(outputDur, (rx / row.clientWidth) * tlDur));
            api.seekToOutputTime?.(ot);
          }
        } else {
          const windowOffset = getWindowOffset();
          const duration = getDisplayDuration();
          const sec = windowOffset + pxToSec(rx, row.clientWidth, duration);
          api.seekTo(Math.max(windowOffset, Math.min(windowOffset + duration, sec)));
        }
      },
      { signal: ac.signal },
    );

    update();
    return update;
  }

  function bindKeyboard(api, gpVideo, fullDuration, getWindowOffset, getDisplayDuration, getAllUpdateFns, ac) {
    document.addEventListener(
      'keydown',
      (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
        const eng = window.wcEngine?.isActive?.() ? window.wcEngine : null;
        switch (e.key) {
          case ' ':
            e.preventDefault();
            if (eng) { eng.paused ? eng.play() : eng.pause(); }
            else { gpVideo.paused ? api.play() : api.pause(); }
            break;
          case 'ArrowLeft':
            e.preventDefault();
            if (eng) eng.seekOutput(eng.currentOutputTime() - NUDGE_FRAMES);
            else api.seekTo(Math.max(getWindowOffset(), gpVideo.currentTime - NUDGE_FRAMES));
            break;
          case 'ArrowRight':
            e.preventDefault();
            if (eng) eng.seekOutput(eng.currentOutputTime() + NUDGE_FRAMES);
            else api.seekTo(Math.min(getWindowOffset() + getDisplayDuration(), gpVideo.currentTime + NUDGE_FRAMES));
            break;
          case '[': {
            e.preventDefault();
            const t = api.getTracks().video;
            api.setMasterTrim(gpVideo.currentTime, t.trimOut);
            getAllUpdateFns().forEach((fn) => fn());
            break;
          }
          case ']': {
            e.preventDefault();
            const t = api.getTracks().video;
            api.setMasterTrim(t.trimIn, fullDuration - gpVideo.currentTime);
            getAllUpdateFns().forEach((fn) => fn());
            break;
          }
          default:
            break;
        }
      },
      { signal: ac.signal },
    );
  }

  function refreshTimelineBars() {
    const fns = window._timelineUpdateFns;
    if (Array.isArray(fns)) fns.forEach((fn) => fn());
    window._timelineSyncPlayhead?.();
  }

  function bindSegmentHandles(clone, api, masterRow, getWindowOffset, getDisplayDuration) {
    const handles = Array.from(clone.querySelectorAll('.track-handle'));
    const hL = handles[0];
    const hR = handles[1];

    if (hL) hL.style.pointerEvents = 'auto';
    if (hR) hR.style.pointerEvents = 'auto';

    const fullDuration = api.getTrackBounds().duration;

    function getCurrentState() {
      const idx      = parseInt(clone.dataset.segClone, 10);
      const segments = api.getSegments?.() ?? [];
      return { idx, seg: segments[idx], totalSegs: segments.length };
    }

    function bindHandle(handle, side) {
      if (!handle) return;
      let live     = false;
      let startX   = 0;
      let startSec = 0;

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { seg } = getCurrentState();
        if (!seg) return;
        live     = true;
        startX   = e.clientX;
        startSec = side === 'left' ? seg.start : seg.end;
        handle.setPointerCapture(e.pointerId);
      });

      handle.addEventListener('pointermove', (e) => {
        if (!live) return;
        const { idx, seg, totalSegs } = getCurrentState();
        if (!seg) return;

        const dSec   = ((e.clientX - startX) / masterRow.clientWidth) * getDisplayDuration();
        let newSec   = startSec + dSec;
        const isFirst = idx === 0;
        const isLast  = idx === totalSegs - 1;
        const MIN_SEG = 1 / 30;

        if (side === 'left') {
          if (isFirst) {
            newSec = Math.max(0, Math.min(seg.end - MIN_SEG, newSec));
            const t = api.getTracks().video;
            api.setMasterTrim(newSec, t.trimOut);
            refreshTimelineBars();
          } else {
            const cuts   = api.getCuts().sort((a, b) => a.start - b.start);
            const cutIdx = cuts.findIndex(c => Math.abs(c.end - seg.start) < 0.5);
            if (cutIdx === -1) return;
            newSec = Math.max(cuts[cutIdx].start, Math.min(seg.end - MIN_SEG, newSec));
            api.setCuts(cuts.map((c, i) => i === cutIdx ? { ...c, end: newSec } : c));
          }
        } else {
          if (isLast) {
            newSec = Math.max(seg.start + MIN_SEG, Math.min(fullDuration, newSec));
            const t = api.getTracks().video;
            api.setMasterTrim(t.trimIn, fullDuration - newSec);
            refreshTimelineBars();
          } else {
            const cuts   = api.getCuts().sort((a, b) => a.start - b.start);
            const cutIdx = cuts.findIndex(c => Math.abs(c.start - seg.end) < 0.5);
            if (cutIdx === -1) return;
            newSec = Math.max(seg.start + MIN_SEG, Math.min(cuts[cutIdx].end, newSec));
            api.setCuts(cuts.map((c, i) => i === cutIdx ? { ...c, start: newSec } : c));
          }
        }
      });

      const end = () => { live = false; };
      handle.addEventListener('pointerup',     end);
      handle.addEventListener('pointercancel', end);
    }

    bindHandle(hL, 'left');
    bindHandle(hR, 'right');
  }

  function mountNLETrack(masterRow, api, getDisplayDuration) {
    if (masterRow._nleReady) return;
    masterRow._nleReady = true;

    masterRow.querySelectorAll('.track-active[data-seg-clone]').forEach(el => el.remove());

    const template = masterRow.querySelector('.track-active:not([data-seg-clone])');
    if (!template) return;

    masterRow.style.position = 'relative';
    masterRow.style.overflow = 'hidden';

    const gap   = 0;
    const MIN_W = 40;
    let bars    = [];

    let trackW = masterRow.clientWidth || 800;

    const initialClips   = api.getClips?.() || [];
    // Timeline span: for a windowed (vod) source it's the FULL source window —
    // fixed, so deleting clips leaves gaps without shrinking the timeline (the
    // user can expand a neighbour later to reclaim the space). Otherwise (live)
    // it's the output duration. (Never absolute source end — that would scale a
    // vod timeline to ~2040s and make the window a sliver.)
    const _win = api.getSourceWindow?.();
    const masterDuration = _win
      ? (_win.end - _win.start)
      : (initialClips.length
          ? (api.getOutputDuration?.() || Math.max(...initialClips.map(c => c.sourceEnd - c.sourceStart)))
          : (getDisplayDuration?.() || 1));
    api._nleTimelineDuration = masterDuration;

    let activeAction    = null;
    let targetBar       = null;
    let pointerStartX   = 0;
    let initialBarX     = 0;
    let initialBarWidth = 0;
    let rollNeighbour         = null;
    let _actionDidMove        = false;
    let initialNeighbourX     = 0;
    let initialNeighbourWidth = 0;
    let initialSourceBoundary = 0;

    function _nleSeek(clientX) {
      if (_toolMode !== null) return;
      const rx = clientX - masterRow.getBoundingClientRect().left;
      const outputDur = api.getOutputDuration?.() ?? 0;
      if (!(outputDur > 0)) return;
      const ot = Math.max(0, Math.min(outputDur, (rx / masterRow.clientWidth) * masterDuration));
      api.seekToOutputTime?.(ot);
    }

    function bindBar(el, barObj) {
      _ensureStateOverlay(el);
      const handles = Array.from(el.querySelectorAll('.track-handle'));
      const hL = handles[0] ?? null;
      const hR = handles[1] ?? null;
      if (hL) { hL.style.display = ''; hL.style.pointerEvents = 'auto'; }
      if (hR) { hR.style.display = ''; hR.style.pointerEvents = 'auto'; }

      el.addEventListener('pointerenter', () => {
        el.classList.add('is-hovered');
        if (_toolMode === 'delete') el.classList.add('is-delete-target');
      });
      el.addEventListener('pointerleave', () => {
        el.classList.remove('is-hovered', 'is-delete-target');
      });

      el.addEventListener('pointerdown', (e) => {
        if (e.target === hL || e.target === hR) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (_toolMode === 'scissor') {
          masterRow._nleSplitBar?.(e.clientX - masterRow.getBoundingClientRect().left);
          return;
        }
        if (_toolMode === 'delete') {
          // Never delete the last clip — that would leave the track empty/unusable.
          if (barObj.clipId && api.deleteClip && (api.getClips?.()?.length || 0) > 1) {
            api.deleteClip(barObj.clipId);
            masterRow._nleRebuild?.();
          }
          return;
        }
        // Normal mode: begin a POTENTIAL drag, but don't seek yet — if the pointer
        // doesn't cross the threshold it's a click (seek + select on pointerup).
        startAction(e, barObj, 'drag');
      });

      if (hL) hL.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (_toolMode === 'scissor') {
          masterRow._nleSplitBar?.(e.clientX - masterRow.getBoundingClientRect().left);
          return;
        }
        startAction(e, barObj, 'resize-left');   // no insta-seek; only resizes once dragged past threshold
      });
      if (hR) hR.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (_toolMode === 'scissor') {
          masterRow._nleSplitBar?.(e.clientX - masterRow.getBoundingClientRect().left);
          return;
        }
        startAction(e, barObj, 'resize-right');
      });
    }

    function applyBarStyles(el, x, w) {
      el.style.display       = '';
      el.style.position      = 'absolute';
      el.style.left          = `${x}px`;
      el.style.top           = '0';
      el.style.bottom        = '0';
      el.style.height        = '';
      el.style.width         = `${w}px`;
      el.style.cursor        = _toolMode ? 'crosshair' : 'grab';
      el.style.userSelect    = 'none';
      el.style.pointerEvents = 'auto';
      el.style.boxSizing     = 'border-box';
      el.style.zIndex        = '';
    }

    // Only the first clip in the chain keeps its title/x tag; the rest hide theirs.
    function updateTitleTags() {
      bars.forEach((b, i) => {
        const tag = b.element.querySelector('.track_tag');
        if (tag) tag.style.display = (i === 0) ? '' : 'none';
      });
    }

    // Tear down and rebuild the bars from the current clip model (after delete, etc.).
    masterRow._nleRebuild = () => {
      masterRow._nleCleanup?.();
      mountNLETrack(masterRow, api, getDisplayDuration);
    };

    // Clip thumbnail: draw a 9:16 filmstrip for this clip's [sourceStart,sourceEnd]
    // into a canvas inside its `.clip_thumbs` div, sampling cached keyframe bitmaps
    // (window.wcThumbs). Panels are cover-cropped to 9:16; count scales with bar
    // width (more on wider bars). Resize just re-draws cached bitmaps — no decode.
    function applyThumb(b) {
      const host = b.element.querySelector('.clip_thumbs');
      if (!host) return;
      let cv = host.querySelector('canvas.clip_thumbs_canvas');
      if (!cv) {
        cv = document.createElement('canvas');
        cv.className = 'clip_thumbs_canvas';
        cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
        host.appendChild(cv);
      }
      const t = window.wcThumbs;
      const bw = b.width || b.element.clientWidth;
      const bh = host.clientHeight || b.element.clientHeight;
      if (!(t && t.ready && t.frames && t.frames.length) || !bw || !bh) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(bw * dpr) || cv.height !== Math.round(bh * dpr)) {
        cv.width = Math.round(bw * dpr); cv.height = Math.round(bh * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, bw, bh);

      const s0 = b.sourceIn * masterDuration, s1 = b.sourceOut * masterDuration;
      const ds = Math.max(0.001, s1 - s0);
      const panelW = Math.max(8, bh * 9 / 16);          // 9:16 portrait panels
      const n  = Math.max(1, Math.round(bw / panelW));
      const pw = bw / n;
      for (let i = 0; i < n; i++) {
        const bmp = t.frameAt(s0 + (i + 0.5) / n * ds);
        if (!bmp) continue;
        const fa = bmp.width / bmp.height, ta = pw / bh;   // cover-crop into the panel slot
        let dw, dh, dx, dy;
        if (fa > ta) { dh = bh; dw = bh * fa; dx = i * pw - (dw - pw) / 2; dy = 0; }
        else        { dw = pw; dh = pw / fa; dx = i * pw; dy = -(dh - bh) / 2; }
        ctx.save(); ctx.beginPath(); ctx.rect(i * pw, 0, pw, bh); ctx.clip();
        ctx.drawImage(bmp, dx, dy, dw, dh);
        ctx.restore();
      }
    }
    masterRow._applyAllThumbs = () => bars.forEach(applyThumb);

    // ── Magnetic snapping (resize) — guide line + snap targets ──
    let _snapGuide = masterRow.querySelector('.nle_snap_guide');
    if (!_snapGuide) {
      _snapGuide = document.createElement('div');
      _snapGuide.className = 'nle_snap_guide';
      Object.assign(_snapGuide.style, {
        position: 'absolute', top: '0', bottom: '0', width: '2px',
        background: '#4da3ff', boxShadow: '0 0 6px rgba(77,163,255,.8)', zIndex: '60',
        pointerEvents: 'none', display: 'none',
      });
      masterRow.appendChild(_snapGuide);
    }
    const SNAP_PX = 8;
    // Snap a moving edge (px in the row) to the playhead or any other clip's edge.
    // Shows/hides the guide; returns the snapped px (or rawPx if nothing in range).
    function snapEdgePx(rawPx, excludeBar) {
      const targets = [];
      const ph = document.getElementById('tl_playhead');
      if (ph) {
        const px = ph.getBoundingClientRect().left - masterRow.getBoundingClientRect().left;
        if (px >= -1 && px <= masterRow.clientWidth + 1) targets.push(px);
      }
      for (const b of bars) {
        if (b === excludeBar) continue;
        targets.push(b.currentX, b.currentX + b.width);
      }
      let best = null, bestD = SNAP_PX;
      for (const t of targets) { const d = Math.abs(rawPx - t); if (d < bestD) { best = t; bestD = d; } }
      if (best != null) { _snapGuide.style.left = `${best}px`; _snapGuide.style.display = 'block'; return best; }
      _snapGuide.style.display = 'none';
      return rawPx;
    }

    if (initialClips.length > 0) {
      const sorted = initialClips.slice().sort((a, b) => a.outputStart - b.outputStart);
      sorted.forEach((clip, i) => {
        const cX = Math.round(clip.outputStart / masterDuration * trackW);
        const cW = Math.max(MIN_W, Math.round((clip.sourceEnd - clip.sourceStart) / masterDuration * trackW));
        const el = (i === 0) ? template : template.cloneNode(true);
        el.dataset.segClone = String(i);
        applyBarStyles(el, cX, cW);
        if (i > 0) masterRow.appendChild(el);
        const barObj = { element: el, width: cW, currentX: cX, id: i, clipId: clip.id,
                         sourceIn: clip.sourceStart / masterDuration, sourceOut: clip.sourceEnd / masterDuration };
        bars.push(barObj);
        bindBar(el, barObj);
      });
    } else {
      applyBarStyles(template, 0, trackW);
      template.dataset.segClone = '0';
      const barObj = { element: template, width: trackW, currentX: 0, id: 0, clipId: api.genClipId(), sourceIn: 0, sourceOut: 1 };
      bars.push(barObj);
      bindBar(template, barObj);
    }
    updateTitleTags();
    masterRow._applyAllThumbs();

    function startAction(e, barObj, type) {
      activeAction    = type;
      targetBar       = barObj;
      pointerStartX   = e.clientX;
      initialBarX     = barObj.currentX;
      initialBarWidth = barObj.width;
      _actionDidMove        = false;
      rollNeighbour         = null;
      initialNeighbourX     = 0;
      initialNeighbourWidth = 0;
      initialSourceBoundary = 0;

      if (type === 'resize-right') {
        initialSourceBoundary = barObj.sourceOut;
        const ridx = bars.indexOf(barObj);
        const rn   = ridx < bars.length - 1 ? bars[ridx + 1] : null;
        if (rn && Math.abs(barObj.currentX + barObj.width - rn.currentX) < 1
               && Math.abs(barObj.sourceOut - rn.sourceIn) < 0.001) {
          rollNeighbour = rn;
          initialNeighbourX     = rn.currentX;
          initialNeighbourWidth = rn.width;
        }
      } else if (type === 'resize-left') {
        initialSourceBoundary = barObj.sourceIn;
        const ridx = bars.indexOf(barObj);
        const ln   = ridx > 0 ? bars[ridx - 1] : null;
        if (ln && Math.abs(ln.currentX + ln.width - barObj.currentX) < 1
               && Math.abs(ln.sourceOut - barObj.sourceIn) < 0.001) {
          rollNeighbour = ln;
          initialNeighbourX     = ln.currentX;
          initialNeighbourWidth = ln.width;
        }
      }

      if (type === 'drag') {
        barObj.element.style.zIndex = '100';
        barObj.element.style.cursor = 'grabbing';
      }
    }

    const DRAG_THRESHOLD = 4;   // px before a press becomes a drag (vs a click-to-seek)
    const REFLOW_EASE    = 'left 170ms cubic-bezier(.22,.61,.36,1)';

    function handleMove(e) {
      if (!activeAction || !targetBar) return;
      const deltaX     = e.clientX - pointerStartX;
      // Below threshold it's still a potential click — don't move/seek yet.
      if (!_actionDidMove && Math.abs(deltaX) < DRAG_THRESHOLD) return;
      if (!_actionDidMove) {
        _actionDidMove = true;
        if (activeAction === 'drag') {
          targetBar.element.classList.add('is-dragging');
          // The grabbed clip tracks the pointer with NO transition; the others
          // get an eased `left` transition so they glide as they reflow.
          targetBar.element.style.transition = 'none';
          bars.forEach(b => { if (b !== targetBar) b.element.style.transition = REFLOW_EASE; });
        }
      }
      const trackWidth = masterRow.clientWidth;
      const idx        = bars.indexOf(targetBar);

      if (activeAction === 'drag') {
        let newX = initialBarX + deltaX;
        if (newX < gap) newX = gap;
        const maxX = trackWidth - targetBar.width - gap;
        if (newX > maxX) newX = maxX;

        targetBar.currentX = newX;
        targetBar.element.style.left = `${newX}px`;

        const center = targetBar.currentX + targetBar.width / 2;

        if (idx > 0) {
          const ln = bars[idx - 1];
          if (center < ln.currentX + ln.width / 2) {
            bars[idx]     = ln;
            bars[idx - 1] = targetBar;
            updateStaticPositions();
            return;
          }
        }
        if (idx < bars.length - 1) {
          const rn = bars[idx + 1];
          if (center > rn.currentX + rn.width / 2) {
            bars[idx]     = rn;
            bars[idx + 1] = targetBar;
            updateStaticPositions();
            return;
          }
        }
      }

      else if (activeAction === 'resize-right') {
        if (rollNeighbour) {
          const maxDelta =  initialNeighbourWidth - MIN_W;
          const minDelta = -(initialBarWidth      - MIN_W);
          const cd          = Math.max(minDelta, Math.min(maxDelta, deltaX));
          const newBoundary = initialSourceBoundary + cd / trackWidth;

          targetBar.width     = initialBarWidth + cd;
          targetBar.sourceOut = newBoundary;
          targetBar.element.style.width = `${targetBar.width}px`;

          rollNeighbour.currentX = initialNeighbourX + cd;
          rollNeighbour.width    = initialNeighbourWidth - cd;
          rollNeighbour.sourceIn = newBoundary;
          rollNeighbour.element.style.left  = `${rollNeighbour.currentX}px`;
          rollNeighbour.element.style.width = `${rollNeighbour.width}px`;
        } else {
          const snappedEdge = snapEdgePx(initialBarX + initialBarWidth + deltaX, targetBar);  // snap right edge
          let newW = Math.max(MIN_W, snappedEdge - initialBarX);
          let maxW = trackWidth - targetBar.currentX - gap;
          for (let i = idx + 1; i < bars.length; i++) maxW -= bars[i].width + gap;
          if (newW > maxW) newW = maxW;
          targetBar.sourceOut = initialSourceBoundary + (newW - initialBarWidth) / trackWidth;
          targetBar.width     = newW;
          targetBar.element.style.width = `${newW}px`;
          updateStaticPositions();
        }
      }

      else if (activeAction === 'resize-left') {
        if (rollNeighbour) {
          const maxDelta =  initialBarWidth      - MIN_W;
          const minDelta = -(initialNeighbourWidth - MIN_W);
          const cd          = Math.max(minDelta, Math.min(maxDelta, deltaX));
          const newBoundary = initialSourceBoundary + cd / trackWidth;

          targetBar.currentX = initialBarX + cd;
          targetBar.width    = initialBarWidth - cd;
          targetBar.sourceIn = newBoundary;
          targetBar.element.style.left  = `${targetBar.currentX}px`;
          targetBar.element.style.width = `${targetBar.width}px`;

          rollNeighbour.width     = initialNeighbourWidth + cd;
          rollNeighbour.sourceOut = newBoundary;
          rollNeighbour.element.style.width = `${rollNeighbour.width}px`;
        } else {
          const snappedEdge = snapEdgePx(initialBarX + deltaX, targetBar);   // snap left edge
          let newX = snappedEdge;
          let newW = initialBarWidth - (snappedEdge - initialBarX);
          let minX = gap;
          for (let i = 0; i < idx; i++) minX += bars[i].width + gap;
          if (newX < minX) { newW -= minX - newX; newX = minX; }
          if (newW < MIN_W) newW = MIN_W;
          targetBar.sourceIn = initialSourceBoundary + (newX - initialBarX) / trackWidth;
          targetBar.currentX = newX;
          targetBar.width    = newW;
          targetBar.element.style.left  = `${newX}px`;
          targetBar.element.style.width = `${newW}px`;
          updateStaticPositions();
        }
      }

      if (activeAction === 'resize-left' || activeAction === 'resize-right') {
        applyThumb(targetBar);                 // live re-slice the filmstrip (cheap CSS)
        if (rollNeighbour) applyThumb(rollNeighbour);
      }
    }

    function endAction() {
      if (!targetBar) return;
      const bar       = targetBar;
      const moved     = _actionDidMove;
      const wasResize = activeAction === 'resize-left' || activeAction === 'resize-right';
      bar.element.style.zIndex = '';
      bar.element.style.cursor = _toolMode ? 'crosshair' : 'grab';
      bar.element.classList.remove('is-dragging');
      activeAction = null; targetBar = null; rollNeighbour = null;
      if (moved && wasResize) {
        // Resize: commit (clamped) then rebuild from the model so any edge that
        // hit the bounds snaps back to a valid position (recoverable handle).
        updateStaticPositions(true);
        syncClipsFromBars();
        masterRow._nleRebuild?.();
      } else if (moved) {
        // Reorder: glide the dropped clip into its final slot, then clear transitions.
        if (bar.element.style.transition === 'none' || !bar.element.style.transition) {
          bar.element.style.transition = REFLOW_EASE;
        }
        updateStaticPositions(true);
        syncClipsFromBars();
        updateTitleTags();
        if (_clearReflowT) clearTimeout(_clearReflowT);
        _clearReflowT = setTimeout(() => { bars.forEach(b => { b.element.style.transition = ''; }); }, 200);
      } else if (!wasResize) {
        // Clean click on a clip body (no drag) → seek there + select it.
        _nleSeek(pointerStartX);
        selectClip(bar);
      }
      if (_snapGuide) _snapGuide.style.display = 'none';
    }
    let _clearReflowT = null;

    function selectClip(bar) {
      _selectActive(bar.element);   // exclusive across all tracks
    }

    function syncClipsFromBars() {
      if (!(masterDuration > 0)) return;
      // Clamp every clip to valid source bounds so a stray resize/snap can't push an
      // edge past the timeline (which breaks playback) or invert the clip. Bounds =
      // the editable region (trim/window) from getTrackBounds.
      const tb  = api.getTrackBounds?.() || {};
      const lo  = isFinite(tb.effectiveStart) ? tb.effectiveStart : 0;
      const hi  = isFinite(tb.effectiveEnd)   ? tb.effectiveEnd   : (lo + masterDuration);
      const MIND = 0.05;
      const newClips = bars.map(b => {
        if (!b.clipId) b.clipId = api.genClipId();
        let s0 = Math.max(lo, Math.min(hi - MIND, b.sourceIn  * masterDuration));
        let s1 = Math.max(s0 + MIND, Math.min(hi, b.sourceOut * masterDuration));
        return {
          id:          b.clipId,
          sourceStart: s0,
          sourceEnd:   s1,
          outputStart: Math.max(0, (b.currentX / trackW) * masterDuration),
        };
      });
      api.setClips(newClips);
    }

    function updateStaticPositions(forceSnapAll = false) {
      let chainX = gap;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (b !== targetBar || forceSnapAll || activeAction === 'resize-left') {
          // Pack to the exact chain position — set, not just push-right — so a
          // larger clip moving aside can't leave a blank gap behind it.
          if (b.currentX !== chainX) {
            b.currentX = chainX;
            b.element.style.left = `${chainX}px`;
          }
        }
        chainX = b.currentX + b.width + gap;
      }
      const maxRight = masterRow.clientWidth - gap;
      let maxChainX  = maxRight;
      for (let i = bars.length - 1; i >= 0; i--) {
        const b = bars[i];
        if (b !== targetBar || forceSnapAll || activeAction === 'resize-right') {
          if (b.currentX + b.width > maxChainX) {
            b.currentX = maxChainX - b.width;
            b.element.style.left = `${b.currentX}px`;
          }
        }
        maxChainX = b.currentX - gap;
      }
      updateTitleTags();   // first-in-chain keeps its title tag as order changes
    }

    masterRow._nleSplitBar = (xInRow) => {
      const barIdx = bars.findIndex(b => xInRow >= b.currentX && xInRow < b.currentX + b.width);
      if (barIdx === -1) return;
      const bar    = bars[barIdx];
      const leftW  = Math.round(xInRow - bar.currentX);
      const rightW = bar.width - leftW;
      if (leftW < MIN_W || rightW < MIN_W) return;

      const sourceCutPos  = bar.sourceIn + (leftW / (leftW + rightW)) * (bar.sourceOut - bar.sourceIn);
      const origSourceOut = bar.sourceOut;

      bar.width     = leftW;
      bar.sourceOut = sourceCutPos;
      bar.element.style.width = `${leftW}px`;

      const newEl = template.cloneNode(true);
      newEl.dataset.segClone    = String(bars.length);
      newEl.style.display       = '';
      newEl.style.position      = 'absolute';
      newEl.style.left          = `${bar.currentX + leftW}px`;
      newEl.style.top           = '0';
      newEl.style.bottom        = '0';
      newEl.style.height        = '';
      newEl.style.width         = `${rightW}px`;
      newEl.style.cursor        = _toolMode ? 'crosshair' : 'grab';
      newEl.style.userSelect    = 'none';
      newEl.style.pointerEvents = 'auto';
      newEl.style.boxSizing     = 'border-box';
      newEl.style.zIndex        = '';

      const newBarObj = { element: newEl, width: rightW, currentX: bar.currentX + leftW, id: bars.length,
                          clipId: api.genClipId(), sourceIn: sourceCutPos, sourceOut: origSourceOut };
      bars.splice(barIdx + 1, 0, newBarObj);
      bar.element.after(newEl);
      bindBar(newEl, newBarObj);
      updateTitleTags();   // clone carried a duplicate title tag — re-dedupe
      applyThumb(bar); applyThumb(newBarObj);   // re-slice both halves
      syncClipsFromBars();
    };

    api._dbgBars = () => bars.map((b, i) => ({
      i,
      clipId:  b.clipId?.slice(-8) ?? 'none',
      srcIn:   +(b.sourceIn  * masterDuration).toFixed(3),
      srcOut:  +(b.sourceOut * masterDuration).toFixed(3),
      outStart:+((b.currentX / trackW) * masterDuration).toFixed(3),
      px:      `${b.currentX}+${b.width}`,
      valid:   b.sourceOut > b.sourceIn,
    }));

    const ro = new ResizeObserver(() => {
      const newW = masterRow.clientWidth;
      if (!newW || newW === trackW) return;
      const scale = newW / trackW;
      trackW = newW;
      bars.forEach(b => {
        b.currentX = Math.round(b.currentX * scale);
        b.width    = Math.max(MIN_W, Math.round(b.width * scale));
        b.element.style.left  = `${b.currentX}px`;
        b.element.style.width = `${b.width}px`;
      });
      masterRow._applyAllThumbs();   // bar widths changed → re-slice filmstrips
    });
    ro.observe(masterRow);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup',   endAction);

    masterRow._nleCleanup = () => {
      ro.disconnect();
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup',   endAction);
      bars.slice(1).forEach(b => b.element.remove());
      const bar0 = bars[0]?.element;
      if (bar0) { bar0.style.cssText = ''; delete bar0.dataset.segClone; }
      masterRow.style.overflow = '';
      masterRow._nleSplitBar = null;
      masterRow._nleReady    = false;
      masterRow._nleCleanup  = null;
    };
  }

  function renderSegmentBlocks(masterRow, api, getWindowOffset, getDisplayDuration) {
    const template = masterRow.querySelector('.track-active:not([data-seg-clone])');
    if (!template) return;

    if (api.getClips?.()?.length > 0) {
      mountNLETrack(masterRow, api, getDisplayDuration);
      return;
    }

    template.style.display = 'none';
    if (!api.getSegments) return;
    const windowOffset = getWindowOffset();
    const displayDur   = getDisplayDuration();
    if (displayDur <= 0) return;

    const segments = api.getSegments();
    const existing  = [...masterRow.querySelectorAll('.track-active[data-seg-clone]')];

    while (existing.length > segments.length) existing.pop().remove();
    while (existing.length < segments.length) {
      const clone = template.cloneNode(true);
      clone.style.display       = '';
      clone.style.position      = 'absolute';
      clone.style.pointerEvents = 'none';
      masterRow.appendChild(clone);
      bindSegmentHandles(clone, api, masterRow, getWindowOffset, getDisplayDuration);
      existing.push(clone);
    }

    segments.forEach((seg, i) => {
      const clone = existing[i];
      clone.dataset.segClone = String(i);
      clone.style.left  = `${((seg.start - windowOffset) / displayDur) * 100}%`;
      clone.style.width = `${Math.max(0, (seg.end - seg.start) / displayDur) * 100}%`;
    });
  }

  let _toolMode = null;

  function _applyToolUI(masterRow) {
    document.getElementById('timeline_scissor_btn')?.classList.toggle('is-active', _toolMode === 'scissor');
    document.getElementById('timeline_delete_btn')?.classList.toggle('is-active', _toolMode === 'delete');
    masterRow.style.cursor = _toolMode ? 'crosshair' : '';
    masterRow.classList.toggle('is-scissor', _toolMode === 'scissor');
    masterRow.classList.toggle('is-delete',  _toolMode === 'delete');
    // Keep the clip bars' cursor in step with the active tool so the crosshair
    // doesn't revert to the grab hand when hovering a clip.
    masterRow.querySelectorAll('.track-active').forEach(b => {
      b.style.cursor = _toolMode ? 'crosshair' : 'grab';
      if (_toolMode !== 'delete') b.classList.remove('is-delete-target');
    });
  }

  function bindScissorTool(masterRow, api, getWindowOffset, getDisplayDuration, ac) {
    const btn = document.getElementById('timeline_scissor_btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      _toolMode = _toolMode === 'scissor' ? null : 'scissor';
      _applyToolUI(masterRow);
    }, { signal: ac.signal });

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && _toolMode === 'scissor') {
          _toolMode = null;
          _applyToolUI(masterRow);
        }
      },
      { signal: ac.signal },
    );

    masterRow.addEventListener(
      'pointerdown',
      (e) => {
        if (masterRow._nleReady && (_toolMode === 'scissor' || _toolMode === 'delete')) return;
        const rx      = e.clientX - masterRow.getBoundingClientRect().left;
        const isNLE   = (api.getClips?.()?.length > 0);

        if (_toolMode !== 'scissor') {
          if (_toolMode === null) {
            if (isNLE) {
              _nleSeek(e.clientX);
            } else {
              const windowOffset = getWindowOffset();
              const displayDur   = getDisplayDuration();
              const sec = windowOffset + Math.max(0, Math.min(1, rx / masterRow.clientWidth)) * displayDur;
              api.seekTo(sec);
            }
          }
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        if (api.splitAtSourceTime) {
          let sourceTime;
          if (api.getClips?.()?.length > 0) {
            const outputDur = api.getOutputDuration?.() ?? 0;
            const tlDur = api._nleTimelineDuration ?? outputDur;
            const ot = Math.max(0, Math.min(outputDur, (rx / masterRow.clientWidth) * tlDur));
            sourceTime = api.outputTimeToSourceTime?.(ot);
            if (sourceTime == null) return;
          } else {
            const windowOffset = getWindowOffset();
            const displayDur   = getDisplayDuration();
            sourceTime = windowOffset + Math.max(0, Math.min(1, rx / masterRow.clientWidth)) * displayDur;
          }
          api.splitAtSourceTime(sourceTime);
        } else {
          const windowOffset = getWindowOffset();
          const displayDur   = getDisplayDuration();
          const sec = windowOffset + Math.max(0, Math.min(1, rx / masterRow.clientWidth)) * displayDur;
          const segments  = api.getSegments?.() ?? [];
          const inContent = segments.some(s => sec >= s.start && sec <= s.end);
          if (inContent) {
            api.addCut(sec);
          } else {
            const cuts = api.getCuts();
            const idx  = cuts.findIndex(c => c.end > c.start && sec >= c.start && sec <= c.end);
            if (idx !== -1) api.removeCut(idx);
          }
        }
      },
      { signal: ac.signal },
    );
  }

  function repositionAfterDelete(api, deletedSeg) {
    const newSegs = api.getSegments();
    const tracks  = api.getTracks();

    Object.keys(tracks)
      .filter(n => n !== 'video')
      .forEach(name => {
        const t      = tracks[name];
        if (!t) return;
        const tStart = t.start ?? 0;

        if (newSegs.some(s => tStart >= s.start && tStart < s.end)) return;

        const target = newSegs.find(s => s.start >= deletedSeg.start) ?? newSegs[newSegs.length - 1];
        if (!target) return;

        const dur = t.end != null ? t.end - tStart : null;
        api.setTrack(name, {
          start: target.start,
          end:   dur != null ? target.start + dur : null,
        });
      });
  }

  function bindDeleteTool(masterRow, api, getWindowOffset, getDisplayDuration, ac) {
    const btn = document.getElementById('timeline_delete_btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      _toolMode = _toolMode === 'delete' ? null : 'delete';
      _applyToolUI(masterRow);
    }, { signal: ac.signal });

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && _toolMode === 'delete') {
          _toolMode = null;
          _applyToolUI(masterRow);
        }
      },
      { signal: ac.signal },
    );

    masterRow.addEventListener(
      'pointerdown',
      (e) => {
        if (masterRow._nleReady) return;
        if (_toolMode !== 'delete') return;

        const rx    = e.clientX - masterRow.getBoundingClientRect().left;
        const isNLE = (api.getClips?.()?.length > 0);

        if (isNLE) {
          const outputDur = api.getOutputDuration?.() ?? 0;
          const tlDur = api._nleTimelineDuration ?? outputDur;
          const ot    = Math.max(0, Math.min(outputDur, (rx / masterRow.clientWidth) * tlDur));
          const clips = api.getOutputClips?.() ?? [];
          const clip  = clips.find(c => ot >= c.outputStart && ot < c.outputEnd);
          if (!clip) return;
          e.preventDefault();
          e.stopPropagation();
          api.deleteClip(clip.id);
          refreshTimelineBars();
        } else {
          const windowOffset = getWindowOffset();
          const displayDur   = getDisplayDuration();
          const sec = windowOffset + Math.max(0, Math.min(1, rx / masterRow.clientWidth)) * displayDur;
          const segments = api.getSegments?.() ?? [];
          const idx      = segments.findIndex(s => sec >= s.start && sec <= s.end);
          if (idx === -1) return;
          e.preventDefault();
          e.stopPropagation();
          const deletedSeg = segments[idx];
          const ok = api.deleteSegment(idx);
          if (!ok) return;
          repositionAfterDelete(api, deletedSeg);
          refreshTimelineBars();
        }
      },
      { signal: ac.signal },
    );
  }

  function initTimeline() {
    const api = window.canvasAPI;
    const container = document.getElementById('timeline_container');
    const gpVideo = document.querySelector('[wized="stream_clip_video"]');
    if (!api || !container || !gpVideo) return;

    const fullDuration = gpVideo.duration;
    if (!isFinite(fullDuration) || fullDuration <= 0) return;
    const getWindowOffset = () => api.getSourceWindow?.()?.start ?? 0;
    const getDisplayDuration = () => {
      const sw = api.getSourceWindow?.();
      return sw ? sw.end - sw.start : fullDuration;
    };

    if (_timelineCleanup) {
      _timelineCleanup();
      _timelineCleanup = null;
    }

    const ac = new AbortController();
    _timelineCleanup = () => {
      ac.abort();
      _toolMode = null;
      document.getElementById('timeline_scissor_btn')?.classList.remove('is-active');
      document.getElementById('timeline_delete_btn')?.classList.remove('is-active');
      container.querySelector('[data-track="video"]')?._nleCleanup?.();
      if (window._timelineResizeObserver) {
        try {
          window._timelineResizeObserver.disconnect();
        } catch (_) {}
        window._timelineResizeObserver = null;
      }
      window._timelineUpdateFns = null;
      window._timelineSyncPlayhead = null;
    };

    const elStart = document.getElementById('tl_time_start');
    const elCurrent = document.getElementById('tl_time_current');
    const elEnd = document.getElementById('tl_time_end');
    const playhead = document.getElementById('tl_playhead');
    if (playhead) playhead.style.pointerEvents = 'none';

    function updateTimeLabels() {
      const isNLE = (api.getClips?.()?.length > 0);
      if (isNLE) {
        // Use the window-anchored timeline length (matches playback), not the sum
        // of clips — otherwise a non-ripple delete shrinks the timecode while the
        // engine still plays the full (gap-padded) window.
        if (elStart) elStart.textContent = fmt(0);
        if (elEnd)   elEnd.textContent   = fmt(api._nleTimelineDuration ?? api.getOutputDuration?.() ?? 0);
      } else {
        if (elStart) elStart.textContent = fmt(getWindowOffset());
        if (elEnd)   elEnd.textContent   = fmt(getWindowOffset() + getDisplayDuration());
      }
    }
    updateTimeLabels();

    const rows = Array.from(container.querySelectorAll('[data-track]'));
    const updateFns = rows
      .map((row) => {
        if (row.dataset.track === 'video') return null;
        return bindTrackRow(row, api, gpVideo, fullDuration, getWindowOffset, getDisplayDuration, ac);
      })
      .filter(Boolean);

    window._timelineUpdateFns = updateFns;
    const getAllUpdateFns = () => updateFns;

    // Move the playhead element to a fractional position (0..1) along the timeline.
    function movePlayheadToPct(pct) {
      if (!playhead) return;
      const firstRow = rows[0];
      if (!firstRow) return;
      const x = firstRow.getBoundingClientRect().left - container.getBoundingClientRect().left + pct * firstRow.clientWidth;
      playhead.style.left = `${x}px`;
    }

    function syncPlayhead() {
      // When the WebCodecs engine owns playback, it IS the clock — read output
      // time straight from it (gpVideo is paused and no longer authoritative).
      const eng = window.wcEngine;
      if (eng?.isActive?.()) {
        // Use the engine's own duration — getOutputDuration() is 0 when there are
        // no clips, which would pin the playhead at the start with no cuts.
        const dur = eng.outputDuration?.() || api._nleTimelineDuration || api.getOutputDuration?.() || 0;
        const ot  = eng.currentOutputTime();
        if (elCurrent) elCurrent.textContent = fmt(ot);
        movePlayheadToPct(dur > 0 ? Math.max(0, Math.min(1, ot / dur)) : 0);
        return;
      }
      if (api.isEnforcerSeeking?.()) return;
      const isNLE = (api.getClips?.()?.length > 0);
      let pct;
      if (isNLE) {
        const dur    = api._nleTimelineDuration ?? api.getOutputDuration?.() ?? 0;
        const clipId = api.getCurrentClipId?.();
        const clips  = api.getOutputClips?.() ?? [];
        const clip   = clipId ? clips.find(c => c.id === clipId) : null;
        let ot;
        if (clip) {
          const t = Math.max(clip.sourceStart, Math.min(clip.sourceEnd, gpVideo.currentTime));
          ot = clip.outputStart + (t - clip.sourceStart);
        } else {
          ot = api.sourceTimeToOutputTime?.(gpVideo.currentTime);
          if (ot == null) return;
        }
        pct = dur > 0 ? Math.max(0, Math.min(1, ot / dur)) : 0;
        if (elCurrent) elCurrent.textContent = fmt(ot);
      } else {
        const _offset = getWindowOffset();
        const _dur    = getDisplayDuration();
        pct = _dur > 0 ? Math.max(0, Math.min(1, (gpVideo.currentTime - _offset) / _dur)) : 0;
        if (elCurrent) elCurrent.textContent = fmt(gpVideo.currentTime);
      }
      movePlayheadToPct(pct);
    }
    window._timelineSyncPlayhead = syncPlayhead;

    // ── Smooth playhead ─────────────────────────────────────────────
    // `timeupdate` only fires ~4x/sec, so the playhead ticks in coarse jumps.
    // Drive it with requestAnimationFrame while the video is actually playing
    // so it glides; fall back to timeupdate/seeked for the paused/stepped case.
    let _rafId = null;
    function rafLoop() {
      if (ac.signal.aborted) { _rafId = null; return; }
      syncPlayhead();
      // Keep animating while gpVideo plays OR the engine owns playback.
      const animate = window.wcEngine?.isActive?.() ? true : (!gpVideo.paused && !gpVideo.ended);
      _rafId = animate ? requestAnimationFrame(rafLoop) : null;
    }
    function startRaf() {
      if (_rafId == null && !ac.signal.aborted) _rafId = requestAnimationFrame(rafLoop);
    }
    window._timelineStartPlayhead = startRaf;   // engine kicks this when it takes over
    gpVideo.addEventListener('play',       startRaf,     { signal: ac.signal });
    gpVideo.addEventListener('playing',    startRaf,     { signal: ac.signal });
    gpVideo.addEventListener('timeupdate', syncPlayhead, { signal: ac.signal });
    gpVideo.addEventListener('seeked',     syncPlayhead, { signal: ac.signal });
    if (!gpVideo.paused) startRaf();
    syncPlayhead();

    // ── Scrubbable playhead ─────────────────────────────────────────
    // Drag the playhead, or click/drag anywhere on an empty part of the
    // timeline, to seek. Disabled while a tool (scissor/delete) is active.
    if (playhead) {
      playhead.style.pointerEvents = 'auto';
      playhead.style.cursor = 'ew-resize';
    }

    function pctFromClientX(clientX) {
      const firstRow = rows[0];
      if (!firstRow || !firstRow.clientWidth) return 0;
      const r = firstRow.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / firstRow.clientWidth));
    }

    function seekToPct(pct) {
      const eng = window.wcEngine;
      if (eng?.isActive?.()) {                       // engine owns playback → seek its clock
        const dur = api._nleTimelineDuration ?? api.getOutputDuration?.() ?? 0;
        if (dur > 0) eng.seekOutput(Math.min(dur - 0.001, pct * dur));
        return;
      }
      const isNLE = (api.getClips?.()?.length > 0);
      if (isNLE) {
        const dur = api._nleTimelineDuration ?? api.getOutputDuration?.() ?? 0;
        if (dur > 0 && api.seekToOutputTime) {
          // outputEnd is exclusive, so nudge off the very end to land in a clip.
          api.seekToOutputTime(Math.min(dur - 0.001, pct * dur));
        }
      } else {
        api.seekTo?.(getWindowOffset() + pct * getDisplayDuration());
      }
    }

    let _scrubbing = false;
    function onScrubMove(e) {
      if (!_scrubbing) return;
      const pct = pctFromClientX(e.clientX);
      movePlayheadToPct(pct);   // immediate visual feedback
      seekToPct(pct);
    }
    function endScrub() {
      if (!_scrubbing) return;
      _scrubbing = false;
      window.removeEventListener('pointermove', onScrubMove);
      window.removeEventListener('pointerup', endScrub);
      document.body.style.userSelect = '';
      syncPlayhead();
    }
    function isScrubTarget(t) {
      if (!t) return false;
      if (t === playhead) return true;
      // Ignore clip blocks, drag handles, and tool buttons — only empty
      // timeline / row background should start a scrub.
      if (t.closest?.('.track-active') || t.closest?.('.track-handle') || t.closest?.('button')) return false;
      return t === container || !!t.closest?.('[data-track]');
    }
    container.addEventListener('pointerdown', (e) => {
      if (_toolMode) return;            // scissor/delete tool owns clicks
      if (e.button !== 0) return;
      if (!isScrubTarget(e.target)) return;
      e.preventDefault();
      _scrubbing = true;
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onScrubMove, { signal: ac.signal });
      window.addEventListener('pointerup',   endScrub,    { signal: ac.signal });
      onScrubMove(e);                   // seek to the click point immediately
    }, { signal: ac.signal });

    const masterRow = container.querySelector('[data-track="video"]');
    if (masterRow) {
      const onMasterMove = () => updateFns.forEach((fn) => fn());
      masterRow.querySelector('.track-active')?.addEventListener('pointermove', onMasterMove, { signal: ac.signal });
      masterRow.querySelectorAll('.track-handle').forEach((h) => {
        h.addEventListener('pointermove', onMasterMove, { signal: ac.signal });
      });
    }

    if (masterRow) {
      const renderSegs = () => renderSegmentBlocks(masterRow, api, getWindowOffset, getDisplayDuration);

      renderSegs();
      window.addEventListener('cutsReady',    renderSegs, { signal: ac.signal });
      window.addEventListener('cutsChanged',  renderSegs, { signal: ac.signal });
      window.addEventListener('clipsReady',   renderSegs, { signal: ac.signal });
      window.addEventListener('clipsChanged', () => { updateTimeLabels(); renderSegs(); syncPlayhead(); }, { signal: ac.signal });
      // Master filmstrip finished decoding → paint thumbnails onto the clip bars.
      window.addEventListener('wcThumbsReady', () => masterRow._applyAllThumbs?.(), { signal: ac.signal });

      updateFns.push(renderSegs);
    }

    if (masterRow) bindScissorTool(masterRow, api, getWindowOffset, getDisplayDuration, ac);
    if (masterRow) bindDeleteTool(masterRow, api, getWindowOffset, getDisplayDuration, ac);

    bindKeyboard(api, gpVideo, fullDuration, getWindowOffset, getDisplayDuration, getAllUpdateFns, ac);

    const ro = new ResizeObserver(() => {
      updateFns.forEach((fn) => fn());
      syncPlayhead();
    });
    ro.observe(container);
    window._timelineResizeObserver = ro;

    // Always start in NLE mode (one clip) so the clip-bar UI + thumbnails show
    // from load. For vod, wait until the source window/trim is applied so the
    // initial clip spans the window, not the whole file.
    (function ensureNLE() {
      if (api.getClips?.()?.length) return;                       // already NLE (or restored)
      const src = gpVideo.currentSrc || gpVideo.src || '';
      const isVod = /vod\.itclips\.live/i.test(src);
      if (isVod && !api.getSourceWindow?.()) { setTimeout(ensureNLE, 150); return; }
      if (!isFinite(gpVideo.duration) || gpVideo.duration <= 0) { setTimeout(ensureNLE, 150); return; }
      api.initClipsFromLegacy?.();   // creates 1 clip over the trim/window → mounts NLE bars + thumbs
    })();
  }

  function boot() {
    if (!window.canvasAPI) {
      setTimeout(boot, 100);
      return;
    }
    const gpVideo = document.querySelector('[wized="stream_clip_video"]');
    if (!gpVideo) {
      setTimeout(boot, 100);
      return;
    }
    if (gpVideo.readyState >= 1 && isFinite(gpVideo.duration) && gpVideo.duration > 0) {
      initTimeline();
    } else {
      gpVideo.addEventListener('loadedmetadata', () => initTimeline(), { once: true });
    }
  }

  window.addEventListener('canvasRestored', () => {
    if (!window.canvasAPI) return;
    if (window._timelineUpdateFns?.length) {
      refreshTimelineBars();
      window._timelineSyncPlayhead?.();
      return;
    }
    const gpVideo = document.querySelector('[wized="stream_clip_video"]');
    if (gpVideo?.readyState >= 1 && isFinite(gpVideo.duration) && gpVideo.duration > 0) {
      initTimeline();
    }
  });

  boot();
})();