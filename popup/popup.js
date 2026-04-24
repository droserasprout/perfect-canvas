"use strict";

const $ = (id) => document.getElementById(id);
const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const statusEl = $("status");

const STORAGE_KEY = "canvasCaptureSettings";

// All persisted field IDs
const PERSISTED_FIELDS = [
  "size-preset",
  "width",
  "height",
  "upscale",
  "fps",
  "duration",
  "quality",
  "speed",
  "profile",
  "output",
];

// Quality to CRF mapping (H.264)
const QUALITY_TO_CRF = {
  0: 28,  // Draft - small files, visible compression
  1: 23,  // Good - balanced
  2: 18,  // High - visually lossless for most content
  3: 14,  // Ultra - overkill for most uses
  4: 0,   // Lossless (CRF 0)
};

// Speed slider → x264/x265 preset. Faster presets trade ~30-40% file size
// for ~2-3× encoder throughput.
const SPEED_TO_PRESET = {
  0: "ultrafast",
  1: "veryfast",
  2: "fast",
  3: "medium",
  4: "slow",
};

let port = null;

const sizePreset = $("size-preset");
const widthInput = $("width");
const heightInput = $("height");

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────

function saveSettings() {
  const settings = {};
  for (const id of PERSISTED_FIELDS) {
    const el = $(id);
    if (!el) continue;
    settings[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const settings = JSON.parse(raw);
    for (const id of PERSISTED_FIELDS) {
      const el = $(id);
      if (!el || settings[id] === undefined) continue;
      if (el.type === "checkbox") el.checked = !!settings[id];
      else el.value = settings[id];
    }
  } catch (e) {
    console.warn("[CC popup] Failed to load settings:", e);
  }
}

function attachPersistenceListeners() {
  for (const id of PERSISTED_FIELDS) {
    const el = $(id);
    if (el) {
      el.addEventListener("change", saveSettings);
      el.addEventListener("input", saveSettings);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Size preset handling
// ─────────────────────────────────────────────────────────────

function handleSizePresetChange() {
  const val = sizePreset.value;

  if (val === "custom") {
    widthInput.disabled = false;
    heightInput.disabled = false;
  } else {
    widthInput.disabled = true;
    heightInput.disabled = true;

    if (val === "native") {
      widthInput.value = "";
      heightInput.value = "";
    } else {
      const [w, h] = val.split("x");
      widthInput.value = w;
      heightInput.value = h;
    }
  }
  saveSettings();
}

sizePreset.addEventListener("change", handleSizePresetChange);

// ─────────────────────────────────────────────────────────────
// Port communication
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Config & UI
// ─────────────────────────────────────────────────────────────

function getConfig() {
  let output = $("output").value;
  output = output.replace(/\.\w+$/, "") + ".mp4";

  const upscaleVal = $("upscale").value;
  const quality = parseInt($("quality").value);
  const crf = QUALITY_TO_CRF[quality];
  const speed = parseInt($("speed").value);
  const preset = SPEED_TO_PRESET[speed];

  return {
    width: parseInt(widthInput.value) || 0,
    height: parseInt(heightInput.value) || 0,
    fps: parseInt($("fps").value),
    duration: parseInt($("duration").value),
    codec: "libx264",
    crf: crf,
    preset: preset,
    output: output,
    upscale: upscaleVal !== "none" ? upscaleVal : null,
    profile: $("profile").checked,
  };
}

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
    case "done": {
      let line = `✅ Done: ${s.frames} frames`;
      if (s.actualFps && s.targetFps) {
        const ratio = s.actualFps / s.targetFps;
        line += ` · ${s.actualFps.toFixed(1)} fps (${ratio.toFixed(2)}× target)`;
      }
      if (s.elapsedMs) {
        line += ` in ${(s.elapsedMs / 1000).toFixed(2)}s`;
      }
      statusEl.textContent = `${line}\n${s.output}`;
      break;
    }
    case "error":
      statusEl.textContent = `❌ ${s.message}`;
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────

function init() {
  loadSettings();
  attachPersistenceListeners();
  handleSizePresetChange(); // Apply loaded preset
  connectPort();
}

init();
