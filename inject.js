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

    return document.querySelector("#glcanvas")
        || document.querySelector("canvas.cables")
        || (all.length > 1
            ? [...all].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]
            : all[0])
        || null;
  }

function resizeApp(canvas, width, height) {
    // Hydra
    try {
      if (typeof window.setResolution === "function") {
        console.log("[CC] Hydra → setResolution()");
        window.setResolution(width, height);
      }
    } catch (e) { console.warn("[CC] setResolution error:", e); }

    // Cables — intercept setSize, don't touch canvas properties directly
    try {
      if (window.CABLES && CABLES.patch && CABLES.patch.cgl) {
        const cgl = CABLES.patch.cgl;
        console.log("[CC] Cables → locking size");

        originalCanvas._cablesSetSize = cgl.setSize.bind(cgl);

        // Redirect: Cables thinks it's resizing, but always gets our size
        cgl.setSize = function (_w, _h) {
          originalCanvas._cablesSetSize(width, height);
        };

        // Trigger initial resize through our locked method
        cgl.setSize(width, height);

        console.log(`[CC] Cables locked at ${width}×${height}`);
        return;
      }
    } catch (e) { console.warn("[CC] Cables lock error:", e); }

    // Generic
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
      const buf = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { data: buf, webgl: true };
    }

    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, width, height);
    return { data: new Uint8Array(imageData.data.buffer), webgl: false };
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
    // Let the app render at the new resolution
    console.log("[CC] Waiting for app to settle after resize...");
    await new Promise((r) => setTimeout(r, 500));

    console.log("[CC] Reading first frame...");
    const firstRead = readPixels(canvas, width, height);
    console.log(`[CC] First frame: ${firstRead.data.length} bytes, webgl=${firstRead.webgl}`);

    window.postMessage({
      type: "__cc_meta",
      meta: {
        type: "meta",
        width, height,
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

      const { data } = readPixels(canvas, width, height);
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

  function startCapture(config) {
    if (capturing) {
      console.warn("[CC] Already capturing");
      return;
    }

    const canvas = findCanvas();
    if (!canvas) {
      console.error("[CC] No <canvas> found!");
      return;
    }

    // Save original state
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
    resizeApp(canvas, width, height);

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

function stopCapture() {
    if (!capturing) return;
    capturing = false;

    window.requestAnimationFrame = origRAF;
    window.cancelAnimationFrame = origCAF;
    Date.now = origDateNow;
    performance.now = origPerfNow;

    if (targetCanvas && originalCanvas.width) {
      if (originalCanvas._cablesSetSize) {
        // Cables: restore setSize, then reload the iframe
        try {
          CABLES.patch.cgl.setSize = originalCanvas._cablesSetSize;
        } catch (_) {}
        originalCanvas._cablesSetSize = null;

        // Reload iframe to fully restore state
        try {
          const iframe = window.frameElement;
          if (iframe) {
            console.log("[CC] Reloading Cables iframe to restore");
            setTimeout(() => { iframe.src = iframe.src; }, 200);
          } else {
            console.log("[CC] Not in iframe, dispatching resize");
            CABLES.patch.cgl.setSize(originalCanvas.width, originalCanvas.height);
            window.dispatchEvent(new Event("resize"));
          }
        } catch (e) {
          console.warn("[CC] Cables restore error:", e);
        }
      } else {
        // Hydra / generic
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
