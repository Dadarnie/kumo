# Windows downloads and builds

Mimo runs on Windows 10 or 11 with WebView2. The current version is **1.0.0**.
An Android version is coming soon.

## Download and verify

[**Download the Windows installer**](https://github.com/Jiocode1/mimo/raw/refs/heads/main/downloads/Mimo-Windows-setup.exe)
directly from this repository. [SHA-256 checksum](../downloads/SHA256SUMS.txt) ·
[Build record](../downloads/build.json)

**The installer is not code-signed yet.** Windows may show an unknown-publisher
or SmartScreen notice.

~~~powershell
Get-FileHash .\Mimo-Windows-setup.exe -Algorithm SHA256
~~~

Compare the result with `downloads/SHA256SUMS.txt`. The checksum identifies the
published file.

## Build from source

Install Node.js 20+, Rust, MSVC C++ build tools and WebView2, then run:

~~~powershell
git clone https://github.com/Jiocode1/mimo.git
cd mimo/windows
npm ci
npm run pack
Get-FileHash release/Mimo-Windows-setup.exe -Algorithm SHA256
~~~

The installer is copied to `windows/release/Mimo-Windows-<version>-setup.exe`
and `windows/release/Mimo-Windows-setup.exe`. Both contain the same file.
The packaging script writes `SHA256SUMS.txt` alongside them. Build output stays
ignored; the selected download in `downloads/` is tracked.

## Update the repository download

Commit the application source, run `npm run pack` in `windows/`, then return to
the repository root:

~~~powershell
node scripts/update-download.mjs
node scripts/check-docs.mjs
~~~

Commit the installer, checksum and build record together. The record preserves
the build commit and a fingerprint of the source and bundled notices, so the
download can still be checked after creating fresh public Git history.

The installer bundles Mimo, the agent relay, 28 original sound cues, icons and
the required [licenses and notices](../legal/README.md).

Keep `windows/package.json`, `windows/Cargo.toml` and
`windows/src-tauri/tauri.conf.json` in sync. Follow the
[contribution guide](../.github/CONTRIBUTING.md) before packaging.

## Export a clean public copy

After merging the reviewed release into the private repository's `main`, switch
to `main` and export its tracked files:

~~~powershell
node scripts/prepare-public.mjs --ref main --out C:\projects\mimo-public.zip
~~~

Use a new output path. The export excludes Git history and local ignored files,
and checks the installer against the source snapshot. Extract it into a new
folder and create a fresh Git repository there. The private repository retains
its existing history; the public copy starts with one initial commit.
