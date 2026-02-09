"use strict";

let injected = false;
let injecting = false;
let framePort = null;

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "start_capture") {
    // Only act if THIS frame has a canvas
    if (!document.querySelector("canvas")) {
      console.log("[CC content] No canvas in this frame, skipping");
      return;
    }
    framePort = browser.runtime.connect({ name: "frames" });
    console.log("[CC content] Frame port opened, injecting capture script");
    injectCaptureScript(msg.config);
  } else if (msg.action === "stop_capture") {
    window.postMessage({ type: "__cc_cmd", action: "stop" }, "*");
  }
});

window.addEventListener("message", (e) => {
  if (!e.data || !e.data.type) return;

  if (e.data.type === "__cc_meta") {
    if (framePort) framePort.postMessage({ type: "meta", meta: e.data.meta });
  } else if (e.data.type === "__cc_frame") {
    if (framePort) framePort.postMessage({ type: "frame", data: e.data.payload });
    // ACK to inject.js: "I've forwarded your frame, send the next one"
    window.postMessage({ type: "__cc_ack" }, "*");
  } else if (e.data.type === "__cc_done") {
    if (framePort) framePort.postMessage({ type: "done", frames: e.data.frames });
    browser.runtime.sendMessage({ type: "capture_ended" });
  } else if (e.data.type === "__cc_progress") {
    if (framePort) framePort.postMessage({ type: "progress", frame: e.data.frame, total: e.data.total });
  }
});

function injectCaptureScript(config) {
  if (injected) {
    window.postMessage({ type: "__cc_cmd", action: "start", config }, "*");
    return;
  }
  if (injecting) {
    const wait = setInterval(() => {
      if (injected) {
        clearInterval(wait);
        window.postMessage({ type: "__cc_cmd", action: "start", config }, "*");
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
