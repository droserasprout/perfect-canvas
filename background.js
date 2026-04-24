"use strict";

const L = (...a) => console.log("[CC bg]", ...a);

let state = { status: "idle" };
let popupPort = null;
let nativePort = null;
let ws = null;

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

  if (port.name === "frames") {
    L("Frame port connected");

    port.onMessage.addListener((msg) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        L("WS not open, dropping", msg.type);
        return;
      }

      if (msg.type === "meta") {
        ws.send(JSON.stringify(msg.meta));
      } else if (msg.type === "frame") {
        ws.send(msg.data);
      } else if (msg.type === "done") {
        ws.send(JSON.stringify({ type: "done", frames: msg.frames }));
      } else if (msg.type === "progress") {
        setState({ frame: msg.frame, total: msg.total });
      }
    });

    port.onDisconnect.addListener(() => L("Frame port disconnected"));
  }
});


async function handleStart(config) {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) {
    setState({ status: "error", error: "No active tab" });
    return;
  }
  const tabId = tabs[0].id;
  L("Active tab:", tabId, tabs[0].url);
  setState({ status: "starting" });

  nativePort = browser.runtime.connectNative("perfect_canvas");
  L("Native port created");

  nativePort.onMessage.addListener((msg) => {
    L("Native message:", msg);

    if (msg.type === "ready") {
      connectWS(msg.ws_port, tabId, config);
    } else if (msg.type === "done") {
      setState({ status: "done", output: msg.output, frames: msg.frames });
      cleanupWS();
      nativePort = null;
    } else if (msg.type === "error") {
      setState({ status: "error", error: msg.message });
      cleanupWS();
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
    cleanupWS();
  });

  nativePort.postMessage({ type: "start", config });
  L("Start sent to native host");
}

function connectWS(port, tabId, config) {
  L(`Opening WS to ws://127.0.0.1:${port}`);

  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    L("WS connected → telling content script to capture");
    setState({ status: "capturing", frame: 0 });
    browser.tabs.sendMessage(tabId, { action: "start_capture", config });
    L("Content script notified");
  };

  ws.onerror = () => {
    L("WS error");
    setState({ status: "error", error: "WebSocket failed in background" });
    if (nativePort) { try { nativePort.disconnect(); } catch (_) {} nativePort = null; }
  };

  ws.onclose = () => {
    L("WS closed");
    ws = null;
  };
}

function cleanupWS() {
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

function handleStop() {
  setState({ status: "stopping" });
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs.length) browser.tabs.sendMessage(tabs[0].id, { action: "stop_capture" });
  });
}

L("Background script loaded ✓");
