# Perfect Canvas

This is a Firefox extension to accurately capture WebGL canvas content. It's designed for algorave/visual programming tools like Hydra and Cables.gl, but should work with any WebGL canvas.

<img src="screenshot.png" alt="Screenshot of Perfect Canvas in action" width="200">

## Features

- Pixel-perfect frame-by-frame capture.
- Configurable resolution, FPS, quality (CRF), and encoder speed (preset).
- Codec choice: libx264 (CPU, default) or h264_vaapi (GPU, AMD/Intel).
- Automatic canvas resize to match capture resolution (restored after).
- Hydra, Cables.gl, and Strudel support: patches `requestAnimationFrame` / `performance.now` so output is frame-perfect regardless of real render speed.
- Optional per-frame timing dump to `/tmp/perfect-canvas-<ts>.log` for profiling.

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

Test settings: 1080x1920, 5s, 30fps, q:high, s:ultrafast, /tmp

| h/w | project | real FPS | file size |
| - | - | - | - | - |
| Ryzen 7 4800HS | Strudel+Hydra, fat project | 25-26 | 117M |
| Ryzen 7 4800HS | Hydra, basic | 30-41 | 22M |
| Ryzen 7 4800HS | Cables.gl, basic | 29-32 | 5.3M |

## Roadmap

- [x] Publish on AMO
- [ ] Bug: FPS affects speed, probably in Strudel only
- [ ] Progress bar in popup UI (rendering speed after capture is already shown)
- [ ] Timeout if no frames are received after some time. Currently just hangs until reload
- [ ] Fix Strudel support; addon doesn't slow down rendering
- [ ] Option to select canvas if multiple are present
- [ ] Add audio capture support (tricky, but possible)
