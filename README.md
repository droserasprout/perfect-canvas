# Perfect Canvas

This is a Firefox extension to accurately capture WebGL canvas content. It's designed for algorave/visual programming tools like Hydra and Cables.gl, but should work with any WebGL canvas.

<img src="screenshot.png" alt="Screenshot of Perfect Canvas in action" width="200">

## Features

- Pixel-perfect frame-by-frame capture.
- Configurable resolution, FPS, quality (CRF), and encoder speed (preset).
- Codec choice: libx264 (CPU, default) or h264_vaapi (GPU, AMD/Intel).
- Automatic canvas resize to match capture resolution (restored after).
- Hydra, Cables.gl, and Strudel support: patches `requestAnimationFrame` / `performance.now` so output is frame-perfect regardless of real render speed.
- Optional per-frame timing dump to `~/.cache/perfect-canvas/profile-<ts>.log` for profiling (with mean/stddev/min/p50/p95/max summary).

## Requirements

- Firefox browser on Linux. Other systems not tested.
- Python 3.10+ with `websockets` package.
- `ffmpeg` installed and available in PATH.

## Installation

```sh
# 0. Clone this repository
git clone https://github.com/droserasprout/perfect-canvas.git

# 1. Install `ffmpeg` and `python-websockets` depending on your OS:

# - Debian/Ubuntu:
sudo apt install ffmpeg python3-websockets
# - Fedora:
sudo dnf install ffmpeg python3-websockets
# - Arch:
sudo pacman -S ffmpeg python-websockets

# 2. Install native component
cd native
sh ./install.sh

# 3. Open `about:debugging` in Firefox, click "Load Temporary Add-on", and select `manifest.json` in the project root.
```

## Performance

Test settings: 1080x1920, 5s, 30fps, q:high, s:ultrafast, /tmp write
Setup #1: Ryzen 7 4800HS, CachyOS Linux

| setup | project | real FPS |
| - | - | - |
| #1, Firefox 140 | Strudel+Hydra, fat project | 25-26 |
| #1, Firefox 140 | [Hydra](https://hydra.ojack.xyz/?code=JTJGJTJGJTIwbGljZW5zZWQlMjB3aXRoJTIwQ0MlMjBCWS1OQy1TQSUyMDQuMCUyMGh0dHBzJTNBJTJGJTJGY3JlYXRpdmVjb21tb25zLm9yZyUyRmxpY2Vuc2VzJTJGYnktbmMtc2ElMkY0LjAlMkYlMEElMkYlMkYlMjBieSUyME9saXZpYSUyMEphY2slMEFvc2MoMjAlMkMlMjAwLjAzJTJDJTIwMS43KSUwQSUwOS5rYWxlaWQoKSUwQSUwOS5tdWx0KG9zYygyMCUyQyUyMDAuMDAxJTJDJTIwMCklMEElMDklMDkucm90YXRlKDEuNTgpKSUwQSUwOS5ibGVuZChvMCUyQyUyMDAuOTQpJTBBJTA5Lm1vZHVsYXRlU2NhbGUob3NjKDEwJTJDJTIwMC43OTMpJTJDJTIwLTAuMDMpJTBBJTA5LnNjYWxlKDAuOCUyQyUyMCgpJTIwJTNEJTNFJTIwMS4wNSUyMCUyQiUyMDAuMDYzJTIwKiUyME1hdGguc2luKDAuMDUlMjAqJTIwdGltZSkpJTBBJTA5Lm91dChvMCklM0I%3D), basic example | 30-41 |
| #1, Firefox 140 | [cables.gl](https://cables.gl/edit/mwt7bf) | 17-32 |
| #1, Hellfire 142 | [cables.gl](https://cables.gl/edit/mwt7bf) | 20-40 |
| #1, Nightly 142 | [cables.gl](https://cables.gl/edit/mwt7bf) | 21-44 |

## Roadmap

- [x] Publish on AMO
- [ ] Bug: FPS affects speed, probably in Strudel only
- [ ] Progress bar in popup UI (rendering speed after capture is already shown)
- [ ] Timeout if no frames are received after some time. Currently just hangs until reload
- [ ] Fix Strudel support; addon doesn't slow down rendering
- [ ] Option to select canvas if multiple are present
- [ ] Add audio capture support (tricky, but possible)
