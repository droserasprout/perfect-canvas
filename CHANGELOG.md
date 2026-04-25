# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to [Semantic Versioning].

## [1.1.0] - 2026-04-24

### Added

- GPU-accelerated codecs: `h264_vaapi` (AMD/Intel) and `h264_nvenc` (NVIDIA).
- Speed slider for encoder preset (ultrafast … slow), mapped per codec.
- Profile checkbox: dumps per-frame timings (RAF, callback, GPU, send, ACK RTT) to `~/.cache/perfect-canvas/profile-<ts>.log` with mean/stddev/min/p50/p95/max summary.
- Async PBO readback on WebGL2 with end-to-end ACK backpressure (one frame of GPU→CPU DMA hidden behind the next render).
- Capture FPS reported in popup after capture finishes.
- Pre-checks for `/dev/dri/renderD128` (VAAPI) and `/dev/nvidia0` (NVENC) — fail fast with a clear error instead of hanging.

### Changed

- WebSocket frame transport moved from runtime port (background.js) to direct `content.js → ws://127.0.0.1` connection. Avoids per-frame structured-clone across process boundary; ~8 MB/frame at 1080p was the dominant per-frame cost.
- Logs moved to `~/.cache/perfect-canvas/`.
- Bounded in-flight pipeline raised from 4 → 32 frames; ffmpeg stdin write-buffer high watermark raised to 256 MB. Absorbs NVENC's per-process cold start (~1.5 s) without stalling the producer.
- `resizeCablesViaUI`: dialog value is no longer divided by `devicePixelRatio`. Cables takes the input as the literal drawing-buffer size; on fractional scaling (e.g. DPR 1.666) the prior code captured at CSS dimensions instead of the requested device pixels.

### Fixed

- Native host now detects ffmpeg early-exit (e.g. CUDA driver mismatch on NVENC, missing VAAPI device) and surfaces stderr as an error message instead of hanging on `stdin.drain()`. stderr is drained continuously so a full pipe can't deadlock the encoder either.
- `inject.js` no longer blocks indefinitely when the WebSocket closes unexpectedly.

## [0.1.0] - 2026-02-10

Initial release.

<!-- Links -->
[keep a changelog]: https://keepachangelog.com/en/1.0.0/
[semantic versioning]: https://semver.org/spec/v2.0.0.html

<!-- Versions -->
[1.1.0]: https://github.com/droserasprout/perfect-canvas/compare/0.1.0...1.1.0
[0.1.0]: https://github.com/droserasprout/perfect-canvas/compare/8175cbe93e42527af9e9abb9aebd1170984ec893...0.1.0
