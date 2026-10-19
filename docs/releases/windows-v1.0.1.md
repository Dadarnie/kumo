# Mimo for Windows 1.0.1

This patch packages the recent UI and feature update as `windows-v1.0.1`.

## Terminal and coding agents

- File edits and command output share one workspace, with edits above the
  terminal and a larger coding panel.
- Reported test counts open the available test or suite details. Node,
  Jest/Vitest, Cargo and pytest summaries are supported; missing counts stay
  unknown and suites remain separate from individual tests.
- The last command result stays available while the agent continues editing.
  File identities, source gutters and completed-action counts stay tied to the
  selected coding session.
- Terminal results use a compact gray card with a centered PASS label, reported
  test counts and duration. Open Details for the available test names. The card
  uses medium-weight JetBrains Mono, a bold black PASS label on green, and comma-separated
  counts. Reported tokens are labeled by prompt, response or session; missing
  values remain hidden. The footer no longer repeats the passed count.
  The agent name, Mimo and stage icons
  share a left edge, and Bash uses the rounded terminal glyph.
- Permission requests use a compact centered glow and a white status dot.
  The coding agent name is bold gray.
  The workflow description appears below the command. Deny, Allow and Always
  appear in that order with their keyboard shortcuts; Always remembers only
  the exact action in the same agent session and workspace.

## Spotify and Windows audio

- Volume, shuffle and repeat show input feedback immediately. Rapid changes
  retain the latest requested value, and failed changes return to confirmed state.
- Spotify volume controls Spotify's own slider and respects its reported step
  size. Windows master volume and other app sessions keep their separate controls.
- Shuffle and repeat controls appear for Spotify. The Media page uses a compact
  Windows audio pill, revised empty and playing layouts, and calmer control motion.

## Desktop UI and Mimo

- Home has a circular Now Playing shortcut beside Limits, with redundant footer
  shortcuts removed. The idle clock no longer adds a vertical divider.
- The island, Terminal and Settings use darker card surfaces and softer borders.
- Shelf fills the available content width and scrolls inside its card at the
  native panel height limit.
- The confused reaction uses the same overlapping service-Mimo stack as file
  intake and returns to Chat with the draft preserved.
- The greeting has a stronger entry sway, gentle body tilt and bob. Lazy panels
  populate before their first paint.
- Right-click controls include Refresh. Mimo stays centered at the top of the
  selected display; obsolete Return to top controls and Ctrl+Alt+Home are removed.

## Download

[Windows x64 installer](../../downloads/Mimo-Windows-setup.exe) ·
[SHA-256 checksum](../../downloads/SHA256SUMS.txt) ·
[Build record](../../downloads/build.json)

The installer, checksum and build record are updated together. README Shelf and
Settings screenshots reflect the current production components with disclosed
local fixtures. The Windows installer remains unsigned.
