# Kumo sounds

The app ships one set of **28 `console-*.wav` files**: Kumo's "lantern" pack.
Every cue is a soft synthesized bell chime in a warm D-major pentatonic, generated
by [`scripts/kumo-sounds.mjs`](../../scripts/kumo-sounds.mjs). No recordings or
samples are used.

All files are 44.1 kHz mono PCM16. Each cue is balanced to a role level using
K-weighted energy in its loudest 400 ms (measured the way Web Audio plays it), with
at least 6 dB of peak headroom; where headroom limits the gain, the achieved level
is recorded as the cue's target. Hover and clicks stay softer than actions and
attention cues. [manifest.json](manifest.json) records each cue's format, duration,
SHA-256 and level.

Regenerate with `node scripts/kumo-sounds.mjs`.
