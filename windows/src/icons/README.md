# Mimo icons

Original pebble-like contours, paired eyes, open interiors, and gentle curves:
24×24 viewBox, approximately 18×18 artwork, 1.6px strokes, rounded caps/joins,
one path per icon, and `currentColor`. No assets, fonts, dependencies, or SVG IDs.
Use 16, 18, 20, or 24px in controls; keep the existing button bounds and labels.
Strokes keep their 1.6 CSS-pixel optical weight with `non-scaling-stroke`, so
compact glyphs stay clear rather than thinning as their viewport shrinks.
Universal control icons share that weight; the heavier pause bars and tiny
activity badges retain their own optical treatment. SVGs render at native DPI.

## Usage

This app uses DOM views, not React. Prefer static imports for tree shaking:

```ts
import { companion, musicMode } from "../icons/glyphs";
import { mimoIcon } from "../icons/render";

button.append(mimoIcon(companion, 18)); // decorative; label the button
button.setAttribute("aria-label", "Show Mimo");
const standalone = mimoIcon(musicMode, 20, { label: "Music mode" });
```

For dynamic names, the optional facade includes the small complete registry:

```ts
import { MimoIcon } from "../icons";
MimoIcon({ name: "compact-mode", size: 18 });
MimoIcon({ name: "winter", size: 18 });
```

All 20 requested designs are in `glyphs.ts`, plus the refined `home` and a matching
`sound-off` state. Home uses a softly arched shelter; music uses one suspended
note with a curved flag and an open oval to stay legible in compact controls.
`secret` represents 0415 with four points rather than unreadable tiny numerals.
Decorative SVGs are hidden from assistive technology and never take focus.
Only standalone meaningful icons get a label and `role="img"`.

## Integration and review

The initial audit found a hand-written SVG registry, two music implementations,
one inline compact glyph, and different strokes in tiny activity indicators.
There is no external icon package or Unicode icon control in the Windows UI.
The migration covers Home, Media navigation/empty states/artwork fallbacks,
sound/mute, compact/collapse, and Settings appearance/media navigation.
Universal actions, playback controls, source-app logos, the static app mark,
and the animated mascot remain their established implementations.

Review every design at actual size on both backgrounds at
`/dev/icon-preview.html` with Vite. This page is development-only and adds no
screens or preferences to the shipped app. The app currently supports Dark and
Glass; the light sheet checks icon legibility without introducing a new theme.
Keep geometry in this module; do not paste SVGs into views. Check negative space,
optical centering, and stroke density before adding a member to the family.

The [Hugeicons rounded showcase](https://hugeicons.com/) informs the controlled
curves and uncluttered interiors. All Mimo path geometry is authored locally.
