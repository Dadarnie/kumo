# Contributing

Bug reports, fixes, docs and small improvements are welcome.

## Report an issue

[Open an issue](https://github.com/Jiocode1/mimo/issues) with the Mimo version,
Windows version, display scaling, steps to reproduce and expected behavior.
Attach relevant logs or screenshots after removing keys and personal information.
Use [private security reporting](SECURITY.md) for sensitive problems.

## Send a fix

1. Fork the repo and create a branch for your change.
2. Build and run Mimo from `windows/`.
3. Keep the change focused and run the checks below.
4. Open a pull request with the problem, resulting behavior and checks run.
   Include a screenshot or clip for a visible change.

## Contribution rules

- Keep each pull request focused on one problem. Discuss larger features in an
  issue before starting a broad redesign.
- Describe the user-visible result and how you checked it. State any remaining
  limitations, especially for native Windows behavior.
- Follow the existing UI, module and storage conventions. Avoid unrelated
  formatting changes, generated files and dependency updates.
- Add or update tests when behavior changes. Documentation and copy changes
  need accurate examples and working links.
- Use production UI and real assets in screenshots. Identify local demo data
  and keep preview source records current.
- Keep keys, tokens, personal logs and private transcripts out of issues and Git.
- Preserve license notices and third-party terms. New assets need a clear source
  and permission to distribute them.
- Be respectful and constructive when discussing changes.

Merged fixes count as contributions. [Contributors](../docs/contributors.md)
are credited in the project and Git history.

## Build and check

Install Node.js 20+, Rust, MSVC C++ build tools and WebView2, then run:

~~~powershell
cd windows
npm ci
npm run tauri dev
~~~

For application changes, run the relevant unit, browser and Rust checks in the
[Windows guide](../windows/README.md). Run `npm run test:agents` for relay or
question changes and `npm run pack` for packaging or bundled assets.

For docs only, run `node scripts/check-docs.mjs` and `git diff --check`.
Refresh media hashes when changing screenshots, GIFs or the installer.

## Keep the existing contracts

Read the [architecture](../docs/architecture.md) and
[companion guide](../docs/companion.md). Keep session ownership, authentication,
terminal fallback, stored settings and concurrent-edit protection intact.

Code contributions use the [MIT license](../LICENSE). Keep upstream notices.
Use your own branding, assets and mascot when distributing a fork; see the
[asset terms](../LICENSE-ASSETS.md).

Keep credentials, promo projects, full exports, references and build output out
of Git. Selected README previews belong in `docs/media/`. The maintained installer
belongs in `downloads/` with its checksum and build record; follow the
[distribution guide](../docs/distribution.md).
