#!/usr/bin/env bash
# Usage: ./publish.sh 1.3.0 "What changed"
# Run from the source/ folder. Builds the exe and publishes it to this repo (bin/<version>/ + latest.json + source/) with a git push.
set -euo pipefail
V="${1:?version}"; NOTES="${2:-}"
REPO="${TINYTWIN_REPO:-erimgiray/TinyTwin-Studio}"
REL="${TINYTWIN_REL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
./build.sh "$V"
# Keep only the current version in the repo: remove older bin/<version> folders
git -C "$REL" rm -rq --ignore-unmatch bin
mkdir -p "$REL/bin/$V"
cp dist/TinyTwinStudio.exe "$REL/bin/$V/TinyTwinStudio.exe"
SUM=$(cut -d' ' -f1 dist/TinyTwinStudio.exe.sha256)
SIZE=$(stat -c %s dist/TinyTwinStudio.exe)
python3 - "$V" "$NOTES" "$REPO" "$SUM" "$SIZE" > "$REL/latest.json" <<'PY'
import json, sys, datetime
v, notes, repo, s, size = sys.argv[1:]
print(json.dumps({"version": v, "notes": notes, "published": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "exe": {"url": f"https://raw.githubusercontent.com/{repo}/main/bin/{v}/TinyTwinStudio.exe", "sha256": s, "size": int(size)}}, indent=2))
PY
cd "$REL"
git add "bin/$V/TinyTwinStudio.exe" latest.json source
git -c user.name="Erim Giray" -c user.email="erimgiray@users.noreply.github.com" commit -qm "Release TinyTwin Studio $V" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01VD5aLhWmpgQYA3odApmqYo"
git push -q origin HEAD:main
echo "published v$V"
