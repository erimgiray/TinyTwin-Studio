# TinyTwin Studio — releases

This repository hosts the published build of **TinyTwin Studio**, the internal Windows app for testing Tiny Twin figure parts and running orders from customer photo to finished print.

Only the **current version** is kept here, so downloading the repository gets one copy of the app:

- `latest.json` — version, release notes, download URL and SHA-256 checksum. The app reads this to check for updates (Settings → Updates) and verifies the checksum before installing.
- `bin/<version>/TinyTwinStudio.exe` — the app (single file, no installer).

To install by hand, download `TinyTwinStudio.exe` from the `bin` folder and run it. Your data lives in `%LOCALAPPDATA%\TinyTwin Studio` and is kept across updates.
