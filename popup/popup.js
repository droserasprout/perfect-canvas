"use strict";

const $ = (id) => document.getElementById(id);
const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const statusEl = $("status");

let port = null;

function connectPort() {
  port = browser.runtime.connect({ name: "popup" });
  console.log("[CC popup] Port connected");

  port.onMessage.addListener((msg) => {
    console.log("[CC popup] Received:", msg);
    if (msg.type === "state") {
      updateUI(msg);
    } else if (msg.type === "progress") {
      const pct = msg.total > 0 ? ((msg.frame / msg.total) * 100).toFixed(1) : "∞";
      statusEl.textContent = `🔴 Frame ${msg.frame}/${msg.total > 0 ? msg.total : "∞"} (${pct}%)`;
    }
  });

  port.onDisconnect.addListener(() => {
    const err = port.error ? port.error.message : "Background disconnected";
    console.error("[CC popup] Port disconnected:", err);
    statusEl.textContent = `❌ ${err}`;
    btnStart.disabled = false;
  });
}

function getConfig() {
  let output = $("output").value;
  const codec = $("codec").value;
  const extMap = {
    libx264: ".mp4",
    prores: ".mov",
    ffv1: ".mkv",
    "libvpx-vp9": ".webm",
  };
  const ext = extMap[codec] || ".mp4";
  output = output.replace(/\.\w+$/, "") + ext;

  const upscale = document.getElementById("upscale").value;
  const sizePreset = document.getElementById("size-preset").value;

  return {
    width: sizePreset === "native" ? 0 : parseInt(document.getElementById("width").value),
    height: sizePreset === "native" ? 0 : parseInt(document.getElementById("height").value),
    fps: parseInt(document.getElementById("fps").value),
    duration: parseInt(document.getElementById("duration").value),
    codec: document.getElementById("codec").value,
    crf: parseInt(document.getElementById("crf").value),
    output: document.getElementById("output").value,
    upscale: upscale !== "none" ? upscale : null,
  };
}

btnStart.addEventListener("click", () => {
  const config = getConfig();
  console.log("[CC popup] Start clicked, config:", config);
  statusEl.textContent = "⏳ Sending start...";

  try {
    port.postMessage({ action: "start", config });
    console.log("[CC popup] Message sent");
  } catch (e) {
    console.error("[CC popup] Send failed:", e);
    statusEl.textContent = `❌ Send failed: ${e.message}`;
  }
});

btnStop.addEventListener("click", () => {
  console.log("[CC popup] Stop clicked");
  port.postMessage({ action: "stop" });
});

function updateUI(s) {
  console.log("[CC popup] State update:", s.status);
  btnStart.style.display = "block";
  btnStop.style.display = "none";
  btnStart.disabled = false;

  switch (s.status) {
    case "idle":
      statusEl.textContent = "Ready";
      break;
    case "starting":
      statusEl.textContent = "⏳ Starting native host...";
      btnStart.disabled = true;
      break;
    case "capturing":
      statusEl.textContent = `🔴 Capturing (frame ${s.frame || 0})`;
      btnStart.style.display = "none";
      btnStop.style.display = "block";
      break;
    case "stopping":
      statusEl.textContent = "⏳ Finalizing...";
      btnStart.disabled = true;
      break;
    case "done":
      statusEl.textContent = `✅ Done: ${s.frames} frames\n${s.output}`;
      break;
    case "error":
      statusEl.textContent = `❌ ${s.message}`;
      break;
  }
}

connectPort();
