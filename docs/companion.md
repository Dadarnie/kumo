# Mimo companion

Mimo is a round, earless silver companion with dark capsule eyes and a
circular status badge. The app icon master is
`windows/mimo-app--icon/mimo-app-icon.png`; its generated exports serve
static branding.

## Rendering and ownership

One code-native Canvas 2D head serves the island, miniatures, greeting, upload
and development study. Preserve the existing shell geometry and animation owner.

| Module | Responsibility |
| --- | --- |
| `src/mimo/face.ts` | Shared sphere material, capsule eyes, expression and badge glyphs |
| `expressions.ts`, `palette.ts`, `status.ts` | Complete poses, contextual colors and actual readiness |
| `engine.ts`, `cursor.ts` | Reactions, tweens, smooth gaze, sound cues and parked rendering |
| `minibots.ts`, `wave.ts`, `greeting.ts` | Shared miniature rendering, wave and greeting lifecycle |
| `brands.ts`, `brands/` | Local vendor marks, badge masks and separate artwork notices |
| `src/upload/` | File-intake scene and completion lifecycle |
| `src/island/island.ts` | Placement, foreground context, visibility and controller ownership |

## Behavior

Keep the silver sphere, larger dark capsule eyes and circular upper-left badge
with its curved separation. Main and mini Mimos share the renderer. State tint
follows the visible badge, then the body; background activity does not recolor
neutral Home. Attention owns its expression and interrupts lower-priority play.

Startup greeting waits for the first eligible hover; compact and Working lip
states do not wave. Native cursor gaze stays bounded and settles when parked.
Three pokes retain the brief confused reaction; cancellation clears old gestures.
Happy closed lids belong to dancing, whistling and confirmed completion.
Only the visible Media panel performs for music. Confirmed Spotify playback
uses the soft mint body tint; paused playback and other players return to silver.

Sleeping mode is removed. Preserve compact coding activity and explicit Review,
keyboard and approval routes. Reuse clocks and buffers; park hidden or settled
surfaces. Legacy internal identifiers do not authorize restoring removed UI.

## Sound, provenance and verification

The app uses [28 original synthesized cues](../windows/assets/sounds/README.md) under
[Mimo's asset terms](../LICENSE-ASSETS.md). The existing sound switch,
volume and idle suspension remain in control. Vendor artwork retains the notices
in [brands/README.md](../windows/src/mimo/brands/README.md).

`dev/mimo-preview.html` is a development fixture outside the production bundle.
Run `npm run test:mimo` for engine/expression/intake checks and
`npm run test:media-ui` for browser behavior. Native validation remains separate;
use [README.md](../windows/README.md) for development and native validation guidance.
