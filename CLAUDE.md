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

**Native host logs**: `~/.local/share/perfect-canvas/host.log`

No test suite or linter is configured.

## Architecture

The system is split into four layers communicating via different IPC mechanisms:

```
popup.js ──runtime.connect──► background.js ──native messaging──► perfect_canvas.py
                                    │                                     │
                               tabs.sendMessage                       WebSocket
                                    │                                     │
                               content.js ──window.postMessage──► inject.js
```

### Layer responsibilities

- **`popup/popup.js`** — UI: size presets, FPS/duration/codec/quality settings (persisted in localStorage). Sends config to `background.js`.
- **`background.js`** — State machine (idle → starting → capturing → done). Spawns native host, relays WebSocket port to content script, routes messages between all other layers.
- **`content.js`** — Runs in page's isolated world. Detects canvas presence, dynamically injects `inject.js` into page context, bridges `window.postMessage` ↔ `runtime.connect`.
- **`inject.js`** — Runs in page JS context (same scope as page code). Core capture logic: patches `requestAnimationFrame`, `Date.now`, and `performance.now` to produce fake deterministic time; reads pixels via WebGL2/Canvas2D; streams binary frames over WebSocket with ACK-based backpressure. Contains platform-specific canvas resize handlers for Hydra, Cables, and a generic fallback.
- **`native/perfect_canvas.py`** — Python asyncio WebSocket server. Receives binary RGBA frames, spawns FFmpeg subprocess, pipes frames to stdin. Builds FFmpeg command for libx264/ProRes/FFV1/VP9. Communicates with `background.js` via Firefox native messaging (4-byte length-prefixed JSON on stdio).

### Key design details

- **Frame timing**: `inject.js` suspends the real RAF loop during capture and drives it manually at the target FPS with injected fake timestamps — this ensures frame-perfect output regardless of actual render speed.
- **Backpressure**: inject.js waits for an ACK from the Python host before sending the next frame, preventing buffer overruns.
- **Canvas resizing**: The extension resizes the canvas to the requested output resolution before capture starts, then restores it afterward. Cables and Hydra require custom resize handlers.
- **Communication boundary**: `inject.js` lives in page context and cannot use browser extension APIs — all extension communication goes through `content.js` via `postMessage`.
