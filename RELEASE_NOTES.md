## Cursor line: line-number chip, optional pseudo-3D band, and a colour picker

The cursor line used to be a single warm background across the whole line. In 1.24.14 it is split into two signals you control separately:

- **Line-number chip** — the cursor line's line number gets a coloured chip in the gutter. It sits outside the text, so the current line is always identifiable without painting anything over the body.
- **Pseudo-3D band** — optional, and on by default. A light top edge, a dark bottom edge and a faint gradient make the line look slightly raised. Turn it off in *Settings → Background → Pseudo-3D band* if a band following the caret feels tiring to your eyes.

Both signals use the same colour:

- **Cursor line colour** — pick any colour; leave it empty to follow the caret colour (brown in light themes, orange in dark ones).
- **Cursor line strength** — one slider scales the line-number chip and the band together.

The band is derived from the cursor-line colour (translucent tints of it) rather than a fixed grey shadow, so it blends with the background instead of looking like a foreign colour laid on top.

### Under the hood

Obsidian's editor never marks the cursor's line number, so CSS had nothing to target. The plugin now registers CodeMirror's `highlightActiveLineGutter` extension, which adds `.cm-activeLineGutter` to the current line's number. The class is painted only while the *Cursor line* background part is enabled, so nothing changes for users who keep it off.
