# Assets

| Asset | Source |
| --- | --- |
| App icon master | `windows/mimo-app--icon/mimo-app-icon.png` |
| UI and Windows icons | `windows/src/assets/app-icon*.png`, `windows/src-tauri/icons/` |
| Companion artwork and renderer | `windows/public/mimo-bot.svg`, `windows/src/mimo/` |
| Original sound cues | `windows/assets/sounds/console-*.wav` |
| Selected promo GIFs | `docs/media/` |
| Drop Shelf and Settings screenshots | `docs/media/screenshots/` |

Run `npm run icons` from `windows/` to regenerate icon exports. Preserve the
supplied artwork and transparency. See the [icon guide](../windows/src/assets/README.md)
and [sound guide](../windows/assets/sounds/README.md).

The [media provenance](media/README.md) records the promo clips and two selected
screenshots.

Full promo projects, exports, posters, design references and runtime captures stay
in ignored local folders. `product-launch/export/` contains the recovered promo;
the private backup retains production files and history. They are excluded from
the public source repository. Local design briefs and reference notes stay
with those production files.

Application code and generation tools use [MIT](../LICENSE). Mimo's branding,
mascot, original artwork and sound files use [separate asset terms](../LICENSE-ASSETS.md).
Earlier asset grants remain recorded in [the license index](../legal/README.md).
Fonts and vendor marks keep their [own notices](../THIRD_PARTY_NOTICES).
