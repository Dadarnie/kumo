# Mimo sounds

The app ships one selected set of **28 `console-*.wav` files**. Nine familiar
Mimo cues and 19 new console cues share the standard event names. There are no
alternate runtime banks or extra variant WAVs in the app folder.

| Source | Cues |
| --- | --- |
| Retained Mimo recordings | `peek`, `open`, `close`, `hover`, `blip`, `gulp`, `tick`, `finish`, `greet` |
| New console recordings | `slap`, `annoyed`, `dizzy`, `work`, `error`, `approval`, `question`, `approve`, `send`, `love`, `pop`, `proud`, `wink`, `yawn`, `attach`, `think`, `search`, `rate`, `sleep` |

The retained files are 48 kHz stereo PCM16. The new files are 44.1 kHz mono
PCM16. Only their gains are balanced; pitch, timing and source format stay intact.
[manifest.json](manifest.json) records the source selection, format, duration
and source/output SHA-256 for every recording, plus its measured loudness and gain.

The balance uses K-weighted energy in each cue's loudest 400 ms, with stereo
analysis matching Web Audio playback. Hover and clicks stay softer than actions
and attention cues. Every output has at least 6 dB peak headroom. Run
`node scripts/balance-sounds.mjs` to inspect levels; `--write` applies the profile.
Untouched copies of both 28-file source sets are kept locally in ignored
`sound-backups/old-set/` and `sound-backups/new-set/` at the repository root.

## Interaction policy

- Panel clicks use the retained digital `blip`; open, close and hover use the
  familiar Mimo cues. The greeting and completion sounds use the retained recordings.
- File intake has one gulp when the file reaches Mimo's mouth, quiet progress
  ticks and one original `finish` chime after the loading animation and file copy finish.
  Starting a drop does not play an approval chime. A failed copy reports its error.
- Starting a Grab drag and saving a Shelf edit do not play an extra notification
  chime. Their existing interaction and visual feedback remain available.
- Permission prompts, actual approval, errors and meaningful work completion
  retain their dedicated notification cues.
- Voice control uses the retained `open` and `close` cues once per transition.
  Talk, Send and Stop use the normal `blip` click. Microphone, transcription and
  playback failures use `error`; sending a desktop voice recording does not add
  a second, different send cue after transcription.
- A file's presence does not mean every event is currently emitted. Keeping the
  `sleep` cue preserves the event name and does not enable sleeping mode.

## Runtime and packaging

`src/core/sound.ts` preloads these 28 files from `/sounds/console-<event>.wav`.
All events share the existing Sound switch, volume control, overlap handling
and idle suspension. Default gain is 0.12; the slider clamps to 0-0.2.

Vite serves the same files in `npm run tauri dev` and copies them into
`dist/sounds/` on build. Reload the app after replacing files, because an open
window can retain decoded buffers from the previous set.

Run from `windows/`:

~~~powershell
node --test scripts/sound-assets.test.mjs scripts/runtime-lifecycle.test.mjs
npm run build
~~~

The historical `scripts/generate-sounds.mjs` synthesizer now writes comparison
prototypes under ignored `target/sound-prototypes/legacy-console/`. It does not
overwrite the selected production pack. Changes to a selected recording should
update its entry in the manifest and pass the asset checks.

Both previous sets and the temporary audition variants remain in verified local
backups under ignored `_prive/sound-backups/`. Full promo assets stay separate;
changing this app pack does not update the frozen promo soundtrack.

The WAV recordings retain [Mimo's asset terms](../../../LICENSE-ASSETS.md).
