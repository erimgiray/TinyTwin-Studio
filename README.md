# TinyTwin Studio — releases

This repository hosts the published builds of **TinyTwin Studio**, the internal Windows app for testing Tiny Twin figure parts and running orders from customer photo to finished print.

The app checks this repository's **latest release** for updates (Settings → Updates). Each release attaches:

- `TinyTwinStudio.exe` — the app (single file, no installer)
- `TinyTwinStudio.exe.sha256` — checksum the updater verifies before installing

To install by hand, download `TinyTwinStudio.exe` from the [latest release](../../releases/latest) and run it. Your data lives in `%LOCALAPPDATA%\TinyTwin Studio` and is kept across updates.
