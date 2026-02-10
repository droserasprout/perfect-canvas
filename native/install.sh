#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="${SCRIPT_DIR}/perfect_canvas.py"
MANIFEST_DIR="${HOME}/.mozilla/native-messaging-hosts"

chmod +x "${HOST_SCRIPT}"

mkdir -p "${MANIFEST_DIR}"

sed "s|%%SCRIPT_PATH%%|${HOST_SCRIPT}|" \
  "${SCRIPT_DIR}/perfect_canvas.json.in" \
  > "${MANIFEST_DIR}/perfect_canvas.json"

echo "✅ Installed native messaging manifest to:"
echo "   ${MANIFEST_DIR}/perfect_canvas.json"
echo ""
echo "   Host script: ${HOST_SCRIPT}"
echo ""
echo "Prerequisites:"
echo "   - ffmpeg in PATH"
echo "   - Python 3.7+"
