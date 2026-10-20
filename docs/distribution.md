# Windows builds

Kumo has no hosted installer yet. Build it from source:

```powershell
cd windows
npm ci
npm run tauri build -- --no-bundle   # → target\release\kumo.exe and kumo-hook.exe
```

Keep `kumo-hook.exe` next to `kumo.exe`; Kumo copies the relay into
`%LOCALAPPDATA%\Kumo\bin` on launch and points installed agent hooks at it.

`npm run pack` builds the NSIS installer (`Kumo-Windows-<version>-setup.exe`) into
`windows/release/`. The `windows.yml` workflow produces the same installer and a
portable build as CI artifacts. Installers are not code-signed, so Windows
SmartScreen may warn on first run.

Upgrading from Mimo: on first launch Kumo copies `%APPDATA%\Mimo` and
`%LOCALAPPDATA%\Mimo` into the Kumo folders, moves the startup entry and re-points
Claude Code, Codex and coding-tool hooks. The Mimo folders are left untouched.
