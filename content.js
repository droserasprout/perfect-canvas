"use strict";

let injected = false;
let injecting = false;
let ws = null;

function teardownWS() {
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "start_capture") {
    // Only act if THIS frame has a canvas
    if (!document.querySelector("canvas")) {
      console.log("[CC content] No canvas in this frame, skipping");
      return;
    }

    teardownWS();
    const url = `ws://127.0.0.1:${msg.ws_port}`;
    console.log("[CC content] Opening", url);
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("[CC content] WS open → injecting capture script");
      injectCaptureScript(msg.config);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "ack") window.postMessage({ type: "__pc_ack" }, "*");
      } catch (_) {}
    };

    ws.onerror = () => {
      console.warn("[CC content] WS error");
      browser.runtime.sendMessage({ type: "capture_error", error: "WebSocket failed in content" });
      teardownWS();
    };

    ws.onclose = () => {
      console.log("[CC content] WS closed");
      ws = null;
      // If the socket dropped while inject was still capturing, unblock
      // its pending ACK queue. stopCapture() is idempotent.
      window.postMessage({ type: "__pc_cmd", action: "stop" }, "*");
    };
  } else if (msg.action === "stop_capture") {
    window.postMessage({ type: "__pc_cmd", action: "stop" }, "*");
  }
});

window.addEventListener("message", (e) => {
  if (!e.data || !e.data.type) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (e.data.type === "__pc_meta") {
    ws.send(JSON.stringify(e.data.meta));
  } else if (e.data.type === "__pc_frame") {
    // payload is an ArrayBuffer transferred zero-copy from the page; WS.send
    // on an ArrayBuffer in the same process goes straight to the socket.
    ws.send(e.data.payload);
  } else if (e.data.type === "__pc_done") {
    ws.send(JSON.stringify({ type: "done", frames: e.data.frames }));
    browser.runtime.sendMessage({
      type: "capture_metrics",
      elapsedMs: e.data.elapsedMs,
      actualFps: e.data.actualFps,
      targetFps: e.data.targetFps,
    });
  } else if (e.data.type === "__pc_progress") {
    browser.runtime.sendMessage({ type: "progress", frame: e.data.frame, total: e.data.total });
  }
});

function injectCaptureScript(config) {
  if (injected) {
    window.postMessage({ type: "__pc_cmd", action: "start", config }, "*");
    return;
  }
  if (injecting) {
    const wait = setInterval(() => {
      if (injected) {
        clearInterval(wait);
        window.postMessage({ type: "__pc_cmd", action: "start", config }, "*");
      }
    }, 50);
    return;
  }

  injecting = true;
  const script = document.createElement("script");
  script.setAttribute("data-config", JSON.stringify(config));
  script.src = browser.runtime.getURL("inject.js");
  script.onload = () => { injected = true; injecting = false; };
  (document.head || document.documentElement).appendChild(script);
}
