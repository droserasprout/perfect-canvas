"use strict";

const L = (...a) => console.log("[CC bg]", ...a);

let state = { status: "idle" };
let popupPort = null;
let nativePort = null;
let activeTabId = null;

function setState(s) {
  Object.assign(state, s);
  L("State →", state.status, state);
  if (popupPort) {
    try { popupPort.postMessage({ type: "state", ...state }); } catch (_) {}
  }
}

browser.runtime.onConnect.addListener((port) => {
  L("Port connected:", port.name);

  if (port.name === "popup") {
    popupPort = port;
    port.postMessage({ type: "state", ...state });

    port.onMessage.addListener((msg) => {
      L("Popup message:", msg);
      if (msg.action === "start") handleStart(msg.config);
      else if (msg.action === "stop") handleStop();
    });

    port.onDisconnect.addListener(() => {
      popupPort = null;
      L("Popup disconnected");
    });
  }
});

// Content script relays progress and completion via one-shot sendMessage.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    setState({ frame: msg.frame, total: msg.total });
  } else if (msg.type === "capture_metrics") {
    setState({
      elapsedMs: msg.elapsedMs,
      actualFps: msg.actualFps,
      targetFps: msg.targetFps,
    });
  } else if (msg.type === "capture_error") {
    setState({ status: "error", error: msg.error });
  }
});

async function handleStart(config) {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) {
    setState({ status: "error", error: "No active tab" });
    return;
  }
  activeTabId = tabs[0].id;
  L("Active tab:", activeTabId, tabs[0].url);
  setState({ status: "starting" });

  nativePort = browser.runtime.connectNative("perfect_canvas");
  L("Native port created");

  nativePort.onMessage.addListener((msg) => {
    L("Native message:", msg);

    if (msg.type === "ready") {
      setState({ status: "capturing", frame: 0 });
      browser.tabs.sendMessage(activeTabId, {
        action: "start_capture",
        config,
        ws_port: msg.ws_port,
      });
      L("Content script notified with ws_port:", msg.ws_port);
    } else if (msg.type === "done") {
      setState({ status: "done", output: msg.output, frames: msg.frames });
      nativePort = null;
    } else if (msg.type === "error") {
      setState({ status: "error", error: msg.message });
      nativePort = null;
    }
  });

  nativePort.onDisconnect.addListener((p) => {
    const err = p.error ? p.error.message : "disconnected";
    L("Native disconnected:", err);
    if (state.status !== "done") {
      setState({ status: "error", error: `Native host: ${err}` });
    }
    nativePort = null;
  });

  nativePort.postMessage({ type: "start", config });
  L("Start sent to native host");
}

function handleStop() {
  setState({ status: "stopping" });
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs.length) browser.tabs.sendMessage(tabs[0].id, { action: "stop_capture" });
  });
}

L("Background script loaded ✓");
