# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Perfect Canvas is a Firefox extension for frame-perfect WebGL canvas capture. It streams raw RGBA frames from a WebGL canvas to a Python native host, which pipes them into FFmpeg to produce MP4/ProRes/VP9 video.

## Commands

```bash
make build    # Package extension into my-extension.zip (excludes native/, .git, cache, docs)
make install  # Run native/install.sh to register the native messaging host with Firefox
```

**Development workflow**: Load `manifest.json` directly in Firefox via `about:debugging` → "Load Temporary Add-on".

**Prerequisites**: Firefox, Python 3.10+ with `websockets` package, `ffmpeg` in PATH.

**Logs**: `~/.cache/perfect-canvas/host.log` (host), `~/.cache/perfect-canvas/profile-<ts>.log` (per-frame profile)

No test suite or linter is configured.

## Architecture

Four layers. Frames flow on a fast path (`inject → content → WebSocket → Python`); control and state flow through background.

```
popup.js ──runtime.connect──► background.js ──native messaging──► perfect_canvas.py
                                    │                                     ▲
                               tabs.sendMessage                           │
                                    │                                WebSocket (frames)
                                    ▼                                     │
                               content.js ◄── window.postMessage ── inject.js
                                    │                  ▲
                                    └────── WebSocket ◄┘ (content owns the socket;
                                                         forwards frames directly)
```

### Layer responsibilities

- **`popup/popup.js`** — UI: size presets, FPS, duration, codec, quality (CRF), speed (preset), output path. Settings persisted in localStorage. Sends config to `background.js`.
- **`background.js`** — Lifecycle only: spawns the native host, relays its `ws_port` to the active tab, and reflects state (starting / capturing / done / error) to the popup. Does **not** touch frames.
- **`content.js`** — Runs in the page's isolated world. On `start_capture` opens the WebSocket to `ws://127.0.0.1:<ws_port>`, injects `inject.js`, then forwards meta/frames/done from the page to the socket and ACKs from the socket back to the page. Progress/metrics forwarded to `background.js` via `runtime.sendMessage`.
- **`inject.js`** — Runs in page JS context. Core capture logic: patches `requestAnimationFrame` / `Date.now` / `performance.now` to produce fake deterministic time; reads pixels via WebGL2 async PBO readback (with WebGL1/Canvas2D sync fallback); streams binary frames via `postMessage` (zero-copy transfer) with a bounded in-flight ACK pipeline. Platform-specific canvas resize handlers for Hydra, Cables, and a generic fallback.
- **`native/perfect_canvas.py`** — Python asyncio WebSocket server. Receives binary RGBA frames, pipes them into an FFmpeg subprocess (libx264/ProRes/FFV1/VP9), sends an ACK JSON back after each `stdin.drain()` completes. Talks to `background.js` over Firefox native messaging (4-byte length-prefixed JSON on stdio) only for lifecycle (`ready` / `done` / `error`).

### Key design details

- **Frame timing**: `inject.js` suspends the real RAF loop during capture and drives it manually at the target FPS with injected fake timestamps — output is frame-perfect regardless of actual render speed.
- **Async GPU readback**: on WebGL2, pixels are read into a ping-ponged pair of `PIXEL_PACK_BUFFER` objects with `fenceSync`; `getBufferSubData` retrieves frame N while the GPU renders frame N+1.
- **End-to-end backpressure**: inject.js waits for an ACK that fires only after Python's `ffmpeg.stdin.drain()` — so the producer paces itself to actual encoder throughput, not to IPC hop speed. Up to `MAX_IN_FLIGHT=4` frames are unacked at once (bounded memory, hidden round-trip).
- **Why the WebSocket is in `content.js`**: runtime ports between content and background structured-clone their payloads across process boundaries. At 8 MB/frame (1080p RGBA) that was the dominant per-frame cost. `content.js` runs in the same process as the page, so `inject → content` stays a zero-copy ArrayBuffer transfer, and `content → WebSocket` is intra-process.
- **Canvas resizing**: The extension resizes the canvas to the requested output resolution before capture and restores it afterward. Cables and Hydra have custom resize paths.
- **Communication boundary**: `inject.js` cannot use extension APIs — it talks to the extension only via `window.postMessage`.
