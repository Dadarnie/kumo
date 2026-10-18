# Mimo app icon

Mimo's supplied master and PNG/ICO exports are Copyright (c) 2026 John Paul,
covered by the [Mimo original asset terms](../../../LICENSE-ASSETS.md).
Historical upstream icons retain their separate notices.

The app icon master is the supplied `mimo-app--icon/mimo-app-icon.png`. Settings, About, the browser favicon, Windows executable, tray, installer and desktop shortcut share exports of that artwork. `app-icon.png` is the 512px raster export; `app-icon-ui.png` is the 256px UI export and covers a 64px mark at 400% DPI.

Run `npm.cmd run icons` to regenerate the PNGs and seven Windows ICO sizes from the supplied master with the installed Tauri icon exporter. `scripts/app-icons.test.mjs` independently decodes the exports to verify sizing, transparency and ICO contents. `public/mimo-bot.svg` remains the companion artwork; the animated companion uses `src/mimo/`.
