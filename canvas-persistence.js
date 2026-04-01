function restoreCanvasState(state) {
  const api = window.canvasAPI;
  if (!api) return;

  requestAnimationFrame(() => {
    // ── 1. Mode first ────────────────────────────────────────────────────────
    if (state.mode) api.setMode(state.mode);

    // ── 2. Split pct immediately after mode ──────────────────────────────────
    if (state.mode === 'is-split' && state.splitPct) {
      window.setSplitPct?.(state.splitPct);
    }

    // ── 3. Zoom + pan — nested RAFs, must run after applyMode's internal RAF ─
    requestAnimationFrame(() => {
      if (state.gameplayZoom) api.setGameplayZoom(state.gameplayZoom);

      requestAnimationFrame(() => {
        if (state.gameplayPanX !== undefined && state.gameplayZoom >= 1) {
          const gpVideo = document.querySelector('[wized="stream_clip_video"]');
          const gpHold  = document.querySelector('.gameplay_hold');
          if (gpVideo && gpHold) {
            const applyPan = () => {
              const gpW  = gpVideo.offsetWidth;
              const gpH  = gpVideo.offsetHeight;
              const gpHW = gpHold.clientWidth;
              const gpHH = gpHold.clientHeight;
              gpVideo.style.left = `${Math.max(gpHW - gpW, Math.min(0, state.gameplayPanX * gpHW))}px`;
              gpVideo.style.top  = `${Math.max(gpHH - gpH, Math.min(0, state.gameplayPanY * gpHH))}px`;
            };
            if (gpVideo.videoWidth) {
              applyPan();
            } else {
              gpVideo.addEventListener('loadedmetadata', applyPan, { once: true });
            }
          }
        }
        window.dispatchEvent(new CustomEvent('canvasRestored'));
      });
    });

    // ── 4. Facecam overlay position + size (overlay mode only) ───────────────
    if (state.mode === 'is-overlay' && state.facecamW) {
      const fw     = document.querySelector('.clip_canvas')?.clientWidth  ?? 1;
      const fh     = document.querySelector('.clip_canvas')?.clientHeight ?? 1;
      const fcHold = document.querySelector('.facecam_hold');
      if (fcHold) {
        fcHold.style.width  = `${state.facecamW * fw}px`;
        fcHold.style.height = `${state.facecamH * fh}px`;
        fcHold.style.left   = `${state.facecamX * fw - (state.facecamW * fw) / 2}px`;
        fcHold.style.top    = `${state.facecamY * fh - (state.facecamH * fh) / 2}px`;
        fcHold._overlayPositioned = true;
      }
    }

    // ── 5. Tracks — master first so clamp runs before secondaries restore ────
    if (state.tracks?.video) {
      api.setMasterTrim(
        state.tracks.video.trimIn  ?? 0,
        state.tracks.video.trimOut ?? 0
      );
    }
    if (state.tracks) {
      Object.entries(state.tracks).forEach(([name, t]) => {
        if (name !== 'video') api.setTrack(name, t);
      });
    }

    // ── 6. Text, zones, toggles ──────────────────────────────────────────────
    if (state.title)                         api.setTitle(state.title);
    if (state.titleZone)                     api.setTitleZone(state.titleZone);
    if (state.subtitleZone)                  api.setSubtitleZone(state.subtitleZone);
    if (state.titleVisible    !== undefined) api.setTitleVisible(state.titleVisible);
    if (state.subtitleVisible !== undefined) api.setSubtitleVisible(state.subtitleVisible);
    if (state.chatBlend)                     api.setChatBlend(state.chatBlend);
    if (state.facecamVisible  !== undefined) api.setFacecamVisible(state.facecamVisible);

    // ── 7. Image — scale first, then position + visibility after double RAF ──
    const liveImageUrl = document.querySelector('[wized="stream_clip_image_url"]')?.textContent.trim();
    if (!liveImageUrl && state.imgSrc) api.setImage(state.imgSrc);

    if (state.imageScale) api.setImageScale(state.imageScale);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (state.imageX     !== undefined) api.setImagePosition(state.imageX, state.imageY);
        if (state.imageVisible !== undefined) api.setImageVisible(state.imageVisible);
      });
    });

    // ── 8. Chat position + size, then visibility ─────────────────────────────
    if (state.chatW) {
      const fw       = document.querySelector('.clip_canvas')?.clientWidth  ?? 1;
      const fh       = document.querySelector('.clip_canvas')?.clientHeight ?? 1;
      const chatHold = document.querySelector('.chat_hold');
      if (chatHold) {
        chatHold.style.width  = `${state.chatW * fw}px`;
        chatHold.style.height = `${state.chatH * fh}px`;
        chatHold.style.left   = `${state.chatX * fw - (state.chatW * fw) / 2}px`;
        chatHold.style.top    = `${state.chatY * fh - (state.chatH * fh) / 2}px`;
      }
    }
    if (state.chatVisible !== undefined) api.setChatVisible(state.chatVisible);
  });
}

window.initCanvasPersistence = function () {
  const clipId = document.querySelector('[wized="stream_clip_id"]')?.textContent.trim();
  if (!clipId || !window.canvasAPI) return;

  const KEY = `canvas_state_${clipId}`;

  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) restoreCanvasState(saved);
  } catch (_) {}

  let lastState = null;
  setInterval(() => {
    if (!window.canvasAPI) return;
    const current = JSON.stringify(window.canvasAPI.getState());
    if (current !== lastState) {
      lastState = current;
      try { localStorage.setItem(KEY, current); } catch (_) {}
    }
  }, 500);
};
