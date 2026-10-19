# Promo media

The silent GIFs come from the current verified launch master,
`product-launch/export/export-4k.mp4`: 3840 x 2160, 60 fps, 74 seconds.
The full production stays local. The footage uses Mimo's production UI,
mascot and assets with local demo records.

## Preview GIFs

| File | Source range | GIF |
| --- | --- | --- |
| `mimo-intro.gif` | 0.1-14.7 and 15.05-23.5 s | 960 x 528, about 23 s, 15 fps |
| `mimo-coding.gif` | 2.8-14.8 s | 960 x 528, about 12 s, 15 fps |

The main GIF includes the greeting, permission review, terminal, GitHub and
Stripe. The coding GIF shows the latest permission design, code-writing motion
and compact PASS result. Both preserve the rectangular framing and loop continuously.
[previews.json](previews.json) records source and output hashes, decoded
durations and frame counts.

## Screenshots

The README shows [Drop Shelf](screenshots/shelf.png) in its own feature section
and [General Settings](screenshots/settings.png) under Desktop and preferences.
Click either thumbnail for the full resolution PNG. Both are unmodified captures
of production components in an
isolated browser. Drop Shelf uses three local example files; Settings uses
default local preferences. No service or account data was read.

[captures.json](screenshots/captures.json) records their dimensions, hashes and
source files. Other captures and production material stay local.

## Refresh the media

Requires the local master, its matching successful verification report, and
Python with Pillow and imageio-ffmpeg.
From the repository root:

~~~powershell
python scripts/render-readme-gifs.py
node scripts/check-docs.mjs
~~~

`icon.png` matches the current application icon. Mimo artwork and sounds use
the [asset terms](../../LICENSE-ASSETS.md); third-party material keeps
its own notices.

The supported-agent badges have [their own sources and notices](agents/README.md).
Rebuild them with `node scripts/render-agent-badges.mjs`.
