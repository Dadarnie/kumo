// SPDX-License-Identifier: MIT
// Export the supplied Mimo app artwork for Windows and the shared UI.
// Run: node scripts/gen-icons.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "mimo-app--icon", "mimo-app-icon.png");
const OUT = join(ROOT, "src-tauri", "icons");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const source = readFileSync(SOURCE);
if (!source.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  || source.readUInt32BE(16) !== source.readUInt32BE(20)
  || source.readUInt32BE(16) < 512)
  throw new Error("The supplied Mimo icon must be a square PNG at least 512px wide.");

mkdirSync(join(ROOT, "target"), { recursive: true });
const exported = mkdtempSync(join(ROOT, "target", "app-icons-"));
const run = spawnSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "icon",
    SOURCE,
    "--output",
    exported,
    ...sizes.flatMap((size) => ["--png", String(size)]),
  ],
  { cwd: ROOT, stdio: "inherit", windowsHide: true },
);
if (run.error) throw run.error;
if (run.status !== 0) throw new Error(`Icon export failed (${run.status}).`);

// PNG-in-ICO keeps the high-quality alpha channel at every Windows icon size.
const entries = sizes
  .filter((size) => size <= 256)
  .map((size) => ({
    size,
    png: readFileSync(join(exported, `${size}x${size}.png`)),
  }));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const directory = Buffer.alloc(entries.length * 16);
let offset = header.length + directory.length;
entries.forEach(({ size, png }, i) => {
  const at = i * 16;
  directory[at] = directory[at + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(png.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
mkdirSync(OUT, { recursive: true });
for (const [name, size] of Object.entries({
  "32x32.png": 32,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
}))
  copyFileSync(join(exported, `${size}x${size}.png`), join(OUT, name));
writeFileSync(
  join(OUT, "icon.ico"),
  Buffer.concat([header, directory, ...entries.map((e) => e.png)]),
);
// 256px covers the largest 64px UI mark at 400% DPI without decoding the master.
copyFileSync(join(exported, "256x256.png"), join(ROOT, "src", "assets", "app-icon-ui.png"));
copyFileSync(join(exported, "512x512.png"), join(ROOT, "src", "assets", "app-icon.png"));
console.log("Exported the supplied Mimo app icon to src-tauri/icons and the shared UI assets.");
