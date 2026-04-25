"use strict";

(function () {
  if (window.__CC_INSTANCE) return;
  window.__CC_INSTANCE = true;

  const scriptEl = document.currentScript;
  const initConfig = scriptEl ? JSON.parse(scriptEl.getAttribute("data-config")) : null;

  let capturing = false;
  let frameCount = 0;
  let totalFrames = 0;
  let fakeTime = 0;
  let frameDuration = 0;
  let captureStartTs = 0;

  // Bounded in-flight pipeline. Producer blocks only when this many frames
  // are unacked; hides per-frame round-trip latency while keeping memory
  // bounded (N × frame size). At 1080p RGBA, 32 × 8MB = 256MB ceiling.
  // Sized to absorb NVENC's ~1.5s first-session init without stalling the
  // producer (32 frames ≈ 1.3s of JS-side capture at 24 FPS).
  const MAX_IN_FLIGHT = 32;
  const pending = [];

  let profileEnabled = false;
  const profileRows = [];   // per-frame timings, push order = frame order
  const ackRtt = {};        // frameNo → ms from postMessage to ACK

  let originalCanvas = {
    width: 0,
    height: 0,
    styleWidth: "",
    styleHeight: "",
    styleObjectFit: "",
  };
  let targetCanvas = null;


  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  const origDateNow = Date.now;
  const origPerfNow = performance.now.bind(performance);

  let frameCallbacks = [];
  let nextId = 1;

  function patchedRAF(cb) {
    if (!capturing) return origRAF(cb);
    const id = nextId++;
    frameCallbacks.push({ id, cb });
    return id;
  }

  function patchedCAF(id) {
    frameCallbacks = frameCallbacks.filter((f) => f.id !== id);
    if (!capturing) origCAF(id);
  }

  function findCanvas() {
    const all = document.querySelectorAll("canvas");
    console.log(`[PC] Found ${all.length} canvas element(s)`);
    all.forEach((c, i) => {
      console.log(`[PC]   #${i}: id="${c.id}" class="${c.className}" ${c.width}×${c.height}`);
    });

    return document.querySelector("#glcanvas")     // Hydra
        || document.querySelector("#hydra-canvas") // Strudel
        || document.querySelector("canvas.cables") // Cables
        || (all.length > 1
            ? [...all].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]
            : all[0])
        || null;
  }

  async function resizeCablesViaUI(width, height) {
    if (typeof CABLES?.CMD?.RENDERER?.changeSize !== "function") {
      return false;
    }

    // Cables takes the dialog value as the literal drawing-buffer size.
    // Don't divide by devicePixelRatio — capture dims are already in device
    // pixels and the encoded video should match exactly.
    console.log(`[PC] Cables dialog: requesting ${width}×${height} buffer`);

    // 1. Open the dialog
    CABLES.CMD.RENDERER.changeSize();

    // 2. Wait for input element to appear (poll up to 2s)
    let input = null;
    let okBtn = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 50));
      input = document.querySelector("#modalpromptinput");
      okBtn = document.querySelector("#prompt_ok");
      if (input && okBtn) break;
    }

    if (!input || !okBtn) {
      console.warn("[PC] Cables modal elements not found");
      document.querySelector(".modalclose")?.click();
      return false;
    }

    // 3. Set value and trigger input event
    input.value = `${width} x ${height}`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // 4. Small delay then click OK with full mouse event sequence
    await new Promise(r => setTimeout(r, 100));

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
    });
    okBtn.dispatchEvent(clickEvent);

    // 5. If modal still open, try Enter key
    await new Promise(r => setTimeout(r, 200));

    const modalStillOpen = document.querySelector(".modalcontainer");
    if (modalStillOpen) {
      console.log("[PC] Modal still open, trying Enter key");
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      });
      input.dispatchEvent(enterEvent);
      await new Promise(r => setTimeout(r, 200));
    }

    // 6. Final fallback: close modal manually
    const stillOpen = document.querySelector(".modalcontainer");
    if (stillOpen) {
      console.warn("[PC] Modal won't close, forcing close");
      document.querySelector(".modalclose")?.dispatchEvent(clickEvent);
      return false;
    }

    await new Promise(r => setTimeout(r, 300));
    return true;
  }

  async function resizeApp(canvas, width, height) {
    // Hydra
    try {
      if (typeof window.setResolution === "function") {
        console.log("[PC] Hydra → setResolution()");
        window.setResolution(width, height);
        return;
      }
    } catch (e) { console.warn("[PC] setResolution error:", e); }

    // Cables — use the UI dialog
    try {
      if (window.CABLES && CABLES.patch && CABLES.patch.cgl) {
        console.log("[PC] Cables → using changeSize() dialog");
        const ok = await resizeCablesViaUI(width, height);
        if (ok) {
          console.log(`[PC] Cables resized to ${width}×${height}`);
          return;
        }
        console.warn("[PC] Cables dialog method failed, falling back");
      }
    } catch (e) { console.warn("[PC] Cables resize error:", e); }

    // Generic fallback
    canvas.width = width;
    canvas.height = height;
    canvas.style.objectFit = "contain";
    window.dispatchEvent(new Event("resize"));
  }

  function readPixels(canvas, gl, width, height) {
    if (gl) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // Clamp to drawing buffer but use requested (even) size
      const readW = Math.min(width, gl.drawingBufferWidth);
      const readH = Math.min(height, gl.drawingBufferHeight);

      const buf = new Uint8Array(readW * readH * 4);
      gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { data: buf, webgl: true, actualWidth: readW, actualHeight: readH };
    }

    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, width, height);
    return { data: new Uint8Array(imageData.data.buffer), webgl: false, actualWidth: width, actualHeight: height };
  }

  // WebGL2 async readback: queue readPixels into a PBO, return a fence.
  // Caller waits on the fence one frame later then getBufferSubData picks
  // up the result. The DMA runs in parallel with the next frame's JS.
  function issuePixelRead(gl, pbo, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  function waitPBOData(gl, pbo, fence, w, h) {
    gl.clientWaitSync(fence, gl.SYNC_FLUSH_COMMANDS_BIT, 1_000_000_000);
    gl.deleteSync(fence);
    const buf = new Uint8Array(w * h * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return buf;
  }

  async function sendFrame(buf, frameNo) {
    // Block until the pipeline has a free slot (FIFO on oldest pending ACK)
    while (capturing && pending.length >= MAX_IN_FLIGHT) {
      await pending[0].promise;
    }
    if (!capturing) return;

    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const enqueuedAt = profileEnabled ? origPerfNow() : 0;
    pending.push({ resolve, promise, frameNo, enqueuedAt });

    window.postMessage({ type: "__pc_frame", payload: buf }, "*", [buf]);
  }

  function onAck() {
    const entry = pending.shift();
    if (!entry) return;
    if (profileEnabled && entry.frameNo) {
      ackRtt[entry.frameNo] = origPerfNow() - entry.enqueuedAt;
    }
    entry.resolve();
  }

  function drainPending() {
    while (pending.length) {
      const entry = pending.shift();
      entry.resolve();
    }
  }

  async function captureLoop(canvas, width, height) {
    console.log("[PC] Waiting for app to settle after resize...");
    await new Promise((r) => setTimeout(r, 500));

    // Determine actual drawing buffer size and make it even
    let gl = null;
    try { gl = canvas.getContext("webgl2"); } catch (_) {}
    if (!gl) try { gl = canvas.getContext("webgl"); } catch (_) {}

    let encW = width;
    let encH = height;
    if (gl) {
      encW = gl.drawingBufferWidth;
      encH = gl.drawingBufferHeight;
    }
    // Force even dimensions
    encW = encW - (encW % 2);
    encH = encH - (encH % 2);
    console.log(`[PC] Encoding at: ${encW}×${encH} (even-aligned)`);

    const isWebGL2 = !!(gl && typeof gl.fenceSync === "function");
    let pboA = null, pboB = null, pboCur = null, fenceCur = null;
    if (isWebGL2) {
      pboA = gl.createBuffer();
      pboB = gl.createBuffer();
      const size = encW * encH * 4;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pboA);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pboB);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      console.log("[PC] WebGL2 async PBO readback enabled");
      // Pre-loop: issue first read (scene 0). Emitted in iter 1 below.
      pboCur = pboA;
      fenceCur = issuePixelRead(gl, pboCur, encW, encH);
    }

    window.postMessage({
      type: "__pc_meta",
      meta: {
        type: "meta",
        width: encW,
        height: encH,
        fps: 1000 / frameDuration,
        webgl: !!gl,
      },
    }, "*");

    await new Promise((r) => setTimeout(r, 150));

    captureStartTs = origPerfNow();

    if (isWebGL2) {
      // Async PBO pipeline: each iter renders frame K+1, issues its readback,
      // then waits on the prior fence (frame K) and emits. One frame of
      // latency in exchange for hiding GPU→CPU DMA behind the next render.
      // Pace on setTimeout(0), not origRAF — we're reading pixels, not
      // presenting; vsync clamping would just lose us slot time.
      while (capturing && frameCount < totalFrames - 1) {
        const tIterStart = profileEnabled ? origPerfNow() : 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!capturing) break;
        const tAfterRaf = profileEnabled ? origPerfNow() : 0;

        fakeTime += frameDuration;
        if (frameCallbacks.length) {
          const callbacks = frameCallbacks.splice(0);
          for (const { cb } of callbacks) {
            try { cb(fakeTime); } catch (e) { console.error("[PC] callback error:", e); }
          }
        }
        if (!capturing) break;
        const tAfterCb = profileEnabled ? origPerfNow() : 0;

        const pboNext = pboCur === pboA ? pboB : pboA;
        const fenceNext = issuePixelRead(gl, pboNext, encW, encH);

        const data = waitPBOData(gl, pboCur, fenceCur, encW, encH);
        const tAfterGpu = profileEnabled ? origPerfNow() : 0;
        const pendingPre = pending.length;
        const frameNo = frameCount + 1;
        await sendFrame(data.buffer, frameNo);
        const tAfterSend = profileEnabled ? origPerfNow() : 0;
        frameCount++;

        if (profileEnabled) {
          profileRows.push({
            frame: frameNo,
            raf_ms: tAfterRaf - tIterStart,
            cb_ms: tAfterCb - tAfterRaf,
            gpu_ms: tAfterGpu - tAfterCb,
            send_ms: tAfterSend - tAfterGpu,
            pending: pendingPre,
          });
        }

        pboCur = pboNext;
        fenceCur = fenceNext;

        if (frameCount % 10 === 0) reportProgress();
      }

      // Drain the last in-flight readback.
      if (capturing && frameCount < totalFrames && fenceCur) {
        const tAfterCb = profileEnabled ? origPerfNow() : 0;
        const data = waitPBOData(gl, pboCur, fenceCur, encW, encH);
        const tAfterGpu = profileEnabled ? origPerfNow() : 0;
        const pendingPre = pending.length;
        const frameNo = frameCount + 1;
        await sendFrame(data.buffer, frameNo);
        const tAfterSend = profileEnabled ? origPerfNow() : 0;
        frameCount++;
        if (profileEnabled) {
          profileRows.push({
            frame: frameNo,
            raf_ms: 0, cb_ms: 0,
            gpu_ms: tAfterGpu - tAfterCb,
            send_ms: tAfterSend - tAfterGpu,
            pending: pendingPre,
          });
        }
        reportProgress();
      } else if (fenceCur) {
        gl.deleteSync(fenceCur);
      }

      gl.deleteBuffer(pboA);
      gl.deleteBuffer(pboB);
    } else {
      // Sync fallback: WebGL1 or Canvas2D.
      const tFirstBeforeRead = profileEnabled ? origPerfNow() : 0;
      const firstRead = readPixels(canvas, gl, encW, encH);
      const tFirstAfterRead = profileEnabled ? origPerfNow() : 0;
      const firstPendingPre = pending.length;
      await sendFrame(firstRead.data.buffer, 1);
      const tFirstAfterSend = profileEnabled ? origPerfNow() : 0;
      frameCount = 1;
      if (profileEnabled) {
        profileRows.push({
          frame: 1,
          raf_ms: 0, cb_ms: 0,
          gpu_ms: tFirstAfterRead - tFirstBeforeRead,
          send_ms: tFirstAfterSend - tFirstAfterRead,
          pending: firstPendingPre,
        });
      }
      reportProgress();

      while (capturing && frameCount < totalFrames) {
        const tIterStart = profileEnabled ? origPerfNow() : 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!capturing) break;
        const tAfterRaf = profileEnabled ? origPerfNow() : 0;

        fakeTime += frameDuration;
        if (frameCallbacks.length) {
          const callbacks = frameCallbacks.splice(0);
          for (const { cb } of callbacks) {
            try { cb(fakeTime); } catch (e) { console.error("[PC] callback error:", e); }
          }
        }
        if (!capturing) break;
        const tAfterCb = profileEnabled ? origPerfNow() : 0;

        const { data } = readPixels(canvas, gl, encW, encH);
        const tAfterGpu = profileEnabled ? origPerfNow() : 0;
        const pendingPre = pending.length;
        const frameNo = frameCount + 1;
        await sendFrame(data.buffer, frameNo);
        const tAfterSend = profileEnabled ? origPerfNow() : 0;
        frameCount++;

        if (profileEnabled) {
          profileRows.push({
            frame: frameNo,
            raf_ms: tAfterRaf - tIterStart,
            cb_ms: tAfterCb - tAfterRaf,
            gpu_ms: tAfterGpu - tAfterCb,
            send_ms: tAfterSend - tAfterGpu,
            pending: pendingPre,
          });
        }

        if (frameCount % 10 === 0) reportProgress();
      }
    }

    stopCapture();
  }

  function reportProgress() {
    console.log(`[PC] Frame ${frameCount}/${totalFrames}`);
    window.postMessage({ type: "__pc_progress", frame: frameCount, total: totalFrames }, "*");
  }

  async function startCapture(config) {
    if (capturing) {
      console.warn("[PC] Already capturing");
      return;
    }

    const canvas = findCanvas();
    if (!canvas) {
      console.error("[PC] No <canvas> found!");
      return;
    }

    targetCanvas = canvas;
    originalCanvas = {
      width: canvas.width,
      height: canvas.height,
      styleWidth: canvas.style.width,
      styleHeight: canvas.style.height,
      styleObjectFit: canvas.style.objectFit,
    };
    console.log(`[PC] Saved original: ${originalCanvas.width}×${originalCanvas.height}`);

    const width = config.width || canvas.width;
    const height = config.height || canvas.height;
    const fps = config.fps || 60;
    const duration = config.duration || 10;

    console.log(`[PC] Target: ${width}×${height} @ ${fps}fps, ${duration}s`);

    await resizeApp(canvas, width, height);  // Must await!

    // Extra settle time for Cables
    if (window.CABLES) {
      await new Promise(r => setTimeout(r, 500));
    }

    frameDuration = 1000 / fps;
    totalFrames = duration > 0 ? Math.round(duration * fps) : Infinity;
    frameCount = 0;
    fakeTime = origPerfNow();
    profileEnabled = !!config.profile;
    profileRows.length = 0;
    for (const k of Object.keys(ackRtt)) delete ackRtt[k];

    window.requestAnimationFrame = patchedRAF;
    window.cancelAnimationFrame = patchedCAF;
    Date.now = () => fakeTime;
    performance.now = () => fakeTime;

    capturing = true;
    console.log(`[PC] Capturing ${width}×${height} @ ${fps}fps → ${totalFrames} frames`);
    captureLoop(canvas, width, height);
  }

  async function stopCapture() {
    if (!capturing) return;
    capturing = false;
    drainPending();

    window.requestAnimationFrame = origRAF;
    window.cancelAnimationFrame = origCAF;
    Date.now = origDateNow;
    performance.now = origPerfNow;

    // Re-queue orphaned callbacks so the app's render loop resumes
    const orphanedCallbacks = frameCallbacks.splice(0);
    for (const { cb } of orphanedCallbacks) {
      origRAF(cb);
    }

    if (targetCanvas && originalCanvas.width) {
      // Cables: restore via UI dialog
      if (window.CABLES && CABLES.CMD?.RENDERER?.changeSize) {
        console.log("[PC] Restoring Cables via dialog");
        try {
          const ok = await resizeCablesViaUI(originalCanvas.width, originalCanvas.height);
          if (ok) {
            console.log("[PC] Cables restored");
          } else {
            // Fallback: reload iframe
            const iframe = window.frameElement;
            if (iframe) {
              console.log("[PC] Dialog failed, reloading iframe");
              setTimeout(() => { iframe.src = iframe.src; }, 200);
            }
          }
        } catch (e) {
          console.warn("[PC] Cables restore error:", e);
        }
      }
      // Hydra / generic
      else {
        targetCanvas.width = originalCanvas.width;
        targetCanvas.height = originalCanvas.height;
        targetCanvas.style.width = originalCanvas.styleWidth;
        targetCanvas.style.height = originalCanvas.styleHeight;
        targetCanvas.style.objectFit = originalCanvas.styleObjectFit;

        try {
          if (typeof window.setResolution === "function") {
            window.setResolution(originalCanvas.width, originalCanvas.height);
          }
        } catch (_) {}
        window.dispatchEvent(new Event("resize"));
      }

      targetCanvas = null;
    }

    const elapsedMs = captureStartTs ? origPerfNow() - captureStartTs : 0;
    const targetFps = frameDuration > 0 ? 1000 / frameDuration : 0;
    const actualFps = elapsedMs > 0 ? (frameCount * 1000) / elapsedMs : 0;
    const ratio = targetFps > 0 ? actualFps / targetFps : 0;
    console.log(
      `[PC] Captured ${frameCount} frames in ${(elapsedMs / 1000).toFixed(2)} s → ` +
      `${actualFps.toFixed(1)} fps (${ratio.toFixed(2)}× target ${targetFps.toFixed(0)} fps)`
    );

    let profile = null;
    if (profileEnabled && profileRows.length) {
      for (const row of profileRows) {
        row.ack_rtt_ms = ackRtt[row.frame] !== undefined ? ackRtt[row.frame] : null;
      }
      profile = profileRows.slice();
    }

    window.postMessage({
      type: "__pc_done",
      frames: frameCount,
      elapsedMs,
      actualFps,
      targetFps,
      profile,
    }, "*");
    console.log(`[PC] Capture stopped at frame ${frameCount}`);
    captureStartTs = 0;
  }

  window.addEventListener("message", (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === "__pc_cmd") {
      if (e.data.action === "start") startCapture(e.data.config);
      if (e.data.action === "stop") stopCapture();
    }
    if (e.data.type === "__pc_ack") {
      onAck();
    }
  });

  if (initConfig) startCapture(initConfig);
})();
