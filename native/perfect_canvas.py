#!/usr/bin/env python3
"""Perfect Canvas — native messaging host with websockets + FFmpeg."""

import asyncio
import csv
import json
import logging
import os
import shutil
import struct
import sys
import threading
import time
from pathlib import Path

try:
    import websockets
except ImportError:
    sys.stderr.write("Missing dependency: pip3 install websockets\n")
    sys.exit(1)

# ─── Logging ──────────────────────────────────────────────────────────────────

LOG_PATH = Path(os.environ.get(
    "CC_LOG", Path.home() / ".local" / "share" / "perfect-canvas" / "host.log"
))
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("cc")

# ─── Native messaging I/O ────────────────────────────────────────────────────

def nm_read():
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    data = b""
    while len(data) < length:
        chunk = sys.stdin.buffer.read(length - len(data))
        if not chunk:
            return None
        data += chunk
    return json.loads(data.decode("utf-8"))


def nm_send(msg):
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

# ─── FFmpeg ───────────────────────────────────────────────────────────────────

def find_ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    for p in ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg",
              str(Path.home() / ".local" / "bin" / "ffmpeg"),
              "/snap/bin/ffmpeg"]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None

VAAPI_DEVICE = os.environ.get("PC_VAAPI_DEVICE", "/dev/dri/renderD128")

def build_ffmpeg_cmd(ffmpeg_bin, width, height, fps, codec, crf, preset, output, vflip, upscale=None):
    cmd = [ffmpeg_bin, "-y", "-loglevel", "warning"]

    # VAAPI needs the device declared before the input.
    if codec == "h264_vaapi":
        cmd += ["-vaapi_device", VAAPI_DEVICE]

    cmd += [
        "-f", "rawvideo", "-pixel_format", "rgba",
        "-video_size", f"{width}x{height}",
        "-framerate", str(fps),
        "-i", "pipe:0",
    ]

    vf = []
    if vflip:
        vf.append("vflip")
    if upscale:
        uw, uh = upscale.split("x")
        vf.append(f"scale={uw}:{uh}:flags=lanczos")

    if codec == "libx264":
        cmd += ["-c:v", "libx264", "-crf", str(crf), "-preset", preset,
                "-pix_fmt", "yuv420p"]
    elif codec == "h264_vaapi":
        # CPU-side filters first (vflip/scale), then hand to GPU via hwupload.
        vf += ["format=nv12", "hwupload"]
        cmd += ["-c:v", "h264_vaapi", "-qp", str(crf)]
    elif codec == "prores":
        cmd += ["-c:v", "prores_ks", "-profile:v", "3",
                "-pix_fmt", "yuv422p10le"]
    elif codec == "ffv1":
        cmd += ["-c:v", "ffv1", "-level", "3", "-pix_fmt", "yuv420p"]
    elif codec == "libvpx-vp9":
        cmd += ["-c:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0",
                "-pix_fmt", "yuv420p"]

    if vf:
        cmd += ["-vf", ",".join(vf)]
    cmd.append(output)
    return cmd

# ─── Profile log ──────────────────────────────────────────────────────────────

PROFILE_COLS = ["frame", "raf_ms", "cb_ms", "gpu_ms", "send_ms", "pending", "ack_rtt_ms"]

def write_profile_log(rows):
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = Path(f"/tmp/perfect-canvas-{ts}.log")
    with path.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(PROFILE_COLS)
        for row in rows:
            ack = row.get("ack_rtt_ms")
            w.writerow([
                row.get("frame"),
                f"{row.get('raf_ms', 0):.2f}",
                f"{row.get('cb_ms', 0):.2f}",
                f"{row.get('gpu_ms', 0):.2f}",
                f"{row.get('send_ms', 0):.2f}",
                row.get("pending", ""),
                f"{ack:.2f}" if ack is not None else "",
            ])
    log.info("Profile written to %s (%d rows)", path, len(rows))

# ─── WebSocket handler ───────────────────────────────────────────────────────

async def handle_ws(websocket, config, done_event):
    frame_count = 0
    ffmpeg_proc = None
    output = os.path.expanduser(config.get("output", "~/Videos/capture.mp4"))
    Path(output).parent.mkdir(parents=True, exist_ok=True)

    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        log.error("ffmpeg not found")
        nm_send({"type": "error", "message": "ffmpeg not found"})
        done_event.set()
        return

    codec = config.get("codec", "libx264")
    if codec == "h264_vaapi" and not os.path.exists(VAAPI_DEVICE):
        msg = (f"VAAPI device not found: {VAAPI_DEVICE} "
               "(override via PC_VAAPI_DEVICE env var)")
        log.error(msg)
        nm_send({"type": "error", "message": msg})
        done_event.set()
        return

    log.info("ffmpeg: %s → %s", ffmpeg_bin, output)

    try:
        async for message in websocket:
            if isinstance(message, str):
                msg = json.loads(message)
                log.info("Text: %s", msg)

                if msg["type"] == "meta":
                    cmd = build_ffmpeg_cmd(
                        ffmpeg_bin,
                        msg["width"], msg["height"], msg["fps"],
                        config.get("codec", "libx264"),
                        config.get("crf", 18),
                        config.get("preset", "veryfast"),
                        output,
                        vflip=msg.get("webgl", False),
                        upscale=config.get("upscale"),
                    )
                    log.info("FFmpeg cmd: %s", " ".join(cmd))
                    ffmpeg_proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdin=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    log.info("FFmpeg pid=%d", ffmpeg_proc.pid)

                elif msg["type"] == "done":
                    log.info("Done signal, frames=%s", msg.get("frames"))
                    profile = msg.get("profile")
                    if profile:
                        try:
                            write_profile_log(profile)
                        except Exception:
                            log.exception("Profile write failed")
                    break

            elif isinstance(message, bytes):
                if ffmpeg_proc and ffmpeg_proc.stdin and not ffmpeg_proc.stdin.is_closing():
                    ffmpeg_proc.stdin.write(message)
                    await ffmpeg_proc.stdin.drain()
                    frame_count += 1
                    if frame_count % 60 == 0:
                        log.info("Frame %d (%d bytes)", frame_count, len(message))
                    try:
                        await websocket.send(json.dumps({"type": "ack"}))
                    except websockets.exceptions.ConnectionClosed:
                        pass

    except websockets.exceptions.ConnectionClosed as e:
        log.warning("WS closed at frame %d: %s", frame_count, e)
    except Exception:
        log.exception("Handler error")

    # Finalize FFmpeg
    stderr_tail = ""
    if ffmpeg_proc:
        try:
            if ffmpeg_proc.stdin and not ffmpeg_proc.stdin.is_closing():
                ffmpeg_proc.stdin.close()
            await asyncio.wait_for(ffmpeg_proc.wait(), timeout=30)
            stderr_tail = (await ffmpeg_proc.stderr.read()).decode(errors="replace")[-500:]
            log.info("FFmpeg exit=%d stderr: %s", ffmpeg_proc.returncode, stderr_tail)
        except Exception:
            log.exception("FFmpeg close error")

    nm_send({
        "type": "done",
        "output": output,
        "frames": frame_count,
        "ffmpeg_log": stderr_tail,
    })
    log.info("Complete: %d frames → %s", frame_count, output)
    done_event.set()

# ─── Main capture session ────────────────────────────────────────────────────

async def run_capture(config):
    done_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    server = await websockets.serve(
        lambda ws: handle_ws(ws, config, done_event),
        "127.0.0.1",
        0,
        max_size=None,           # frames can be 8MB+
        compression=None,        # don't compress binary frames
        ping_interval=None,      # no keepalive pings
        ping_timeout=None,
    )

    port = server.sockets[0].getsockname()[1]
    log.info("WebSocket server on 127.0.0.1:%d", port)
    nm_send({"type": "ready", "ws_port": port})

    stop = asyncio.Event()

    def listen_stdin():
        try:
            while True:
                msg = nm_read()
                if msg is None or msg.get("type") == "stop":
                    log.info("Stdin: stop/EOF")
                    loop.call_soon_threadsafe(stop.set)
                    break
        except Exception:
            log.exception("Stdin error")
            loop.call_soon_threadsafe(stop.set)

    threading.Thread(target=listen_stdin, daemon=True).start()

    await asyncio.wait(
        [asyncio.ensure_future(done_event.wait()),
         asyncio.ensure_future(stop.wait())],
        return_when=asyncio.FIRST_COMPLETED,
    )

    log.info("Shutting down")
    server.close()
    await server.wait_closed()

# ─── Entry ────────────────────────────────────────────────────────────────────

def main():
    log.info("=== Native host started pid=%d ===", os.getpid())
    log.info("Python %s", sys.version)

    msg = nm_read()
    log.info("Initial: %s", msg)

    if not msg or msg.get("type") != "start":
        log.error("Expected 'start', got: %s", msg)
        nm_send({"type": "error", "message": "Expected start message"})
        return

    config = msg.get("config", {})
    log.info("Config: %s", config)

    try:
        asyncio.run(run_capture(config))
    except Exception:
        log.exception("Fatal error")
        nm_send({"type": "error", "message": "Fatal: check " + str(LOG_PATH)})

    log.info("=== Exiting ===")


if __name__ == "__main__":
    main()
