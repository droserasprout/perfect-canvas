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
  let ackResolve = null;

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
    origCAF(id);
  }

  function findCanvas() {
    const all = document.querySelectorAll("canvas");
    console.log(`[CC] Found ${all.length} canvas element(s)`);
    all.forEach((c, i) => {
      console.log(`[CC]   #${i}: id="${c.id}" class="${c.className}" ${c.width}×${c.height}`);
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

    // Cables multiplies by devicePixelRatio internally,
    // so we must divide to get the exact drawing buffer size we want
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(width / dpr);
    const cssH = Math.round(height / dpr);
    console.log(`[CC] Cables dialog: requesting ${cssW}×${cssH} CSS (DPR ${dpr}) → target ${width}×${height} buffer`);

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
      console.warn("[CC] Cables modal elements not found");
      document.querySelector(".modalclose")?.click();
      return false;
    }

    // 3. Set value and trigger input event
    input.value = `${cssW} x ${cssH}`;
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
      console.log("[CC] Modal still open, trying Enter key");
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
      console.warn("[CC] Modal won't close, forcing close");
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
        console.log("[CC] Hydra → setResolution()");
        window.setResolution(width, height);
        return;
      }
    } catch (e) { console.warn("[CC] setResolution error:", e); }

    // Cables — use the UI dialog
    try {
      if (window.CABLES && CABLES.patch && CABLES.patch.cgl) {
        console.log("[CC] Cables → using changeSize() dialog");
        const ok = await resizeCablesViaUI(width, height);
        if (ok) {
          console.log(`[CC] Cables resized to ${width}×${height}`);
          return;
        }
        console.warn("[CC] Cables dialog method failed, falling back");
      }
    } catch (e) { console.warn("[CC] Cables resize error:", e); }

    // Generic fallback
    canvas.width = width;
    canvas.height = height;
    canvas.style.objectFit = "contain";
    window.dispatchEvent(new Event("resize"));
  }

  function readPixels(canvas, width, height) {
    let gl = null;
    try { gl = canvas.getContext("webgl2"); } catch (_) {}
    if (!gl) try { gl = canvas.getContext("webgl"); } catch (_) {}

    if (gl) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const dbW = gl.drawingBufferWidth;
      const dbH = gl.drawingBufferHeight;

      // Clamp to drawing buffer but use requested (even) size
      const readW = Math.min(width, dbW);
      const readH = Math.min(height, dbH);

      console.log(`[CC] readPixels: target ${width}×${height}, drawingBuffer ${dbW}×${dbH}, reading ${readW}×${readH}`);

      const buf = new Uint8Array(readW * readH * 4);
      gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { data: buf, webgl: true, actualWidth: readW, actualHeight: readH };
    }

    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, width, height);
    return { data: new Uint8Array(imageData.data.buffer), webgl: false, actualWidth: width, actualHeight: height };
  }

  function waitForAck() {
    return new Promise((resolve) => {
      ackResolve = resolve;
      // Safety timeout — if ACK is lost, don't hang forever
      setTimeout(() => {
        if (ackResolve === resolve) {
          console.warn("[CC] ACK timeout, continuing");
          ackResolve = null;
          resolve();
        }
      }, 2000);
    });
  }

  async function sendFrame(buf) {
    window.postMessage({ type: "__cc_frame", payload: buf }, "*", [buf]);
    await waitForAck();
  }

  async function captureLoop(canvas, width, height) {
    console.log("[CC] Waiting for app to settle after resize...");
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
    console.log(`[CC] Encoding at: ${encW}×${encH} (even-aligned)`);

    console.log("[CC] Reading first frame...");
    const firstRead = readPixels(canvas, encW, encH);

    window.postMessage({
      type: "__cc_meta",
      meta: {
        type: "meta",
        width: encW,
        height: encH,
        fps: 1000 / frameDuration,
        webgl: firstRead.webgl,
      },
    }, "*");

    await new Promise((r) => setTimeout(r, 150));

    await sendFrame(firstRead.data.buffer.slice(0));
    frameCount = 1;
    console.log("[CC] First frame sent");
    reportProgress();

    while (capturing && frameCount < totalFrames) {
      await new Promise((resolve) => origRAF(resolve));
      if (!capturing) break;

      const callbacks = frameCallbacks.splice(0);
      fakeTime += frameDuration;
      for (const { cb } of callbacks) {
        try { cb(fakeTime); } catch (e) { console.error("[CC] callback error:", e); }
      }

      if (!capturing) break;

      const { data } = readPixels(canvas, encW, encH);
      await sendFrame(data.buffer.slice(0));
      frameCount++;

      if (frameCount % 10 === 0) reportProgress();
      if (frameCount % 30 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    stopCapture();
  }

  function reportProgress() {
    console.log(`[CC] Frame ${frameCount}/${totalFrames}`);
    window.postMessage({ type: "__cc_progress", frame: frameCount, total: totalFrames }, "*");
  }

  async function startCapture(config) {
    if (capturing) {
      console.warn("[CC] Already capturing");
      return;
    }

    const canvas = findCanvas();
    if (!canvas) {
      console.error("[CC] No <canvas> found!");
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
    console.log(`[CC] Saved original: ${originalCanvas.width}×${originalCanvas.height}`);

    const width = config.width || canvas.width;
    const height = config.height || canvas.height;
    const fps = config.fps || 60;
    const duration = config.duration || 10;

    console.log(`[CC] Target: ${width}×${height} @ ${fps}fps, ${duration}s`);

    await resizeApp(canvas, width, height);  // Must await!

    // Extra settle time for Cables
    if (window.CABLES) {
      await new Promise(r => setTimeout(r, 500));
    }

    frameDuration = 1000 / fps;
    totalFrames = duration > 0 ? Math.round(duration * fps) : Infinity;
    frameCount = 0;
    fakeTime = origPerfNow();

    window.requestAnimationFrame = patchedRAF;
    window.cancelAnimationFrame = patchedCAF;
    Date.now = () => fakeTime;
    performance.now = () => fakeTime;

    capturing = true;
    console.log(`[CC] Capturing ${width}×${height} @ ${fps}fps → ${totalFrames} frames`);
    captureLoop(canvas, width, height);
  }

  async function stopCapture() {
    if (!capturing) return;
    capturing = false;

    window.requestAnimationFrame = origRAF;
    window.cancelAnimationFrame = origCAF;
    Date.now = origDateNow;
    performance.now = origPerfNow;

    // Re-queue orphaned callbacks so the app's render loop resumes
    const pending = frameCallbacks.splice(0);
    for (const { cb } of pending) {
      origRAF(cb);
    }

    if (targetCanvas && originalCanvas.width) {
      // Cables: restore via UI dialog
      if (window.CABLES && CABLES.CMD?.RENDERER?.changeSize) {
        console.log("[CC] Restoring Cables via dialog");
        try {
          const ok = await resizeCablesViaUI(originalCanvas.width, originalCanvas.height);
          if (ok) {
            console.log("[CC] Cables restored");
          } else {
            // Fallback: reload iframe
            const iframe = window.frameElement;
            if (iframe) {
              console.log("[CC] Dialog failed, reloading iframe");
              setTimeout(() => { iframe.src = iframe.src; }, 200);
            }
          }
        } catch (e) {
          console.warn("[CC] Cables restore error:", e);
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

    window.postMessage({ type: "__cc_done", frames: frameCount }, "*");
    console.log(`[CC] Capture stopped at frame ${frameCount}`);
  }

  window.addEventListener("message", (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === "__cc_cmd") {
      if (e.data.action === "start") startCapture(e.data.config);
      if (e.data.action === "stop") stopCapture();
    }
    if (e.data.type === "__cc_ack" && ackResolve) {
      const r = ackResolve;
      ackResolve = null;
      r();
    }
  });

  if (initConfig) startCapture(initConfig);
})();
