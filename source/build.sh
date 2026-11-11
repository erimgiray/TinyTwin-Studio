#!/usr/bin/env bash
# Usage: ./build.sh 1.2.0   → dist/TinyTwinStudio.exe (+ .sha256) and a Linux test build
set -euo pipefail
V="${1:?version}"
export GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPROXY=direct GOSUMDB=off
npx esbuild src/main.js --bundle --minify --format=iife --target=es2020 --outfile=web/dist/app.js --log-level=warning
npx esbuild src/worker.js --bundle --minify --format=iife --target=es2020 --outfile=web/dist/worker.js --log-level=warning
mkdir -p dist
LD="-s -w -X main.version=$V"
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui $LD" -o dist/raw.exe .
npx resedit --in dist/raw.exe --out dist/TinyTwinStudio.exe --icon 1,assets/icon.ico \
  --product-name "TinyTwin Studio" --file-description "TinyTwin Studio" --company-name "Tiny Twin" \
  --product-version "$V.0" --file-version "$V.0" --original-filename TinyTwinStudio.exe
rm dist/raw.exe
(cd dist && sha256sum TinyTwinStudio.exe > TinyTwinStudio.exe.sha256)
go build -ldflags "$LD" -o dist/TinyTwinStudio-linux .
(cd dist && sha256sum TinyTwinStudio-linux > TinyTwinStudio-linux.sha256)
echo "built v$V"
