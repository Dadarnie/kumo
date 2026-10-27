// SPDX-License-Identifier: MIT
// Copies the packages Tauri buries in target/release/bundle/ into
// windows/release/, with the names they ship under. Used by `npm run pack` and
// by the release workflows, so both produce exactly the same file names.

import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(root, "target", "release", "bundle");
const outDir = join(root, "release");

const { productName, version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

// Keep the installer names used by the Windows release workflow and downloads.
const packages = [
  {
    dir: "nsis",
    suffix: "-setup.exe",
    names: [`Kumo-Windows-${version}-setup.exe`, "Kumo-Windows-setup.exe"],
  },
];

/** Select this product and version, even when another build is still lying around. */
function newest(dir, suffix) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(`${productName}_${version}_`) && f.endsWith(suffix));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return files
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

mkdirSync(outDir, { recursive: true });
const written = [];
for (const { dir, suffix, names } of packages) {
  const built = newest(join(bundleRoot, dir), suffix);
  if (!built) {
    console.error(`No ${productName}_${version}_*${suffix} in ${join(bundleRoot, dir)} — run \`npm run tauri build\` first.`);
    process.exit(1);
  }
  for (const name of names) {
    const dest = join(outDir, name);
    copyFileSync(built, dest);
    written.push(dest);
  }
}

// Signed build (TAURI_SIGNING_PRIVATE_KEY set): the in-app updater's feed, served from the
// rolling windows-latest release and pointing at this version's installer.
const installer = newest(join(bundleRoot, "nsis"), "-setup.exe");
try {
  const signature = readFileSync(`${installer}.sig`, "utf8");
  const feed = join(outDir, "latest.json");
  writeFileSync(feed, JSON.stringify({
    version,
    notes: `Kumo ${version}`,
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": {
      signature,
      url: `https://github.com/Dadarnie/kumo/releases/download/windows-v${version}/Kumo-Windows-${version}-setup.exe`,
    } },
  }, null, 2) + "
");
  written.push(feed);
} catch { /* unsigned local build: no update feed */ }

const checksums = written.map(file =>
  `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}`,
);
const checksumFile = join(outDir, "SHA256SUMS.txt");
writeFileSync(checksumFile, checksums.join("\n") + "\n");

console.log("\n  Packages ready\n");
for (const f of written) {
  const mb = (statSync(f).size / 1024 / 1024).toFixed(2);
  console.log(`  ${f}  (${mb} MB)`);
}
console.log(`  ${checksumFile}`);
console.log();
