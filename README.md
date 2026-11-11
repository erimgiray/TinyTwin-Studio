# TinyTwin Studio

**TinyTwin Studio** is the internal Windows app for testing Tiny Twin figure parts and running orders from customer photo to finished print.

## What's here

- `latest.json` — version, release notes, download URL and SHA-256 checksum. The app reads this to check for updates (Settings → Updates) and verifies the checksum before installing.
- `bin/<version>/TinyTwinStudio.exe` — the app (single file, no installer). Only the current version is kept.
- `source/` — the app's source code (Go + JavaScript).

To install by hand, download `TinyTwinStudio.exe` from the `bin` folder and run it. Your data lives in `%LOCALAPPDATA%\TinyTwin Studio` and is kept across updates.

## Building and publishing

From `source/` (needs Go, Node and Python 3):

```bash
npm install
./publish.sh 1.4.1 "What changed"
```

This builds the exe, replaces the old build in `bin/`, updates `latest.json` and pushes everything, including the source, to `main`.
