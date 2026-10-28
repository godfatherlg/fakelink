## 中文

### 光标行：行号色块、可选伪 3D 色带、颜色选择器

光标行以前是整行一条暖色背景。1.24.14 把它拆成两个可分别控制的部分：

- **行号色块** —— 当前行的行号在左侧 gutter 显示色块。它在正文之外，不覆盖文字，所以即使关闭行内色带，也能一眼认出当前行。
- **伪 3D 色带** —— 可选，默认开启。顶部亮边 + 底部暗边 + 淡渐变，让这一行看起来微微凸起。如果色带跟着光标移动让你觉得累眼，可在 *设置 → 背景 → 伪 3D 色带* 中关闭。

两处使用同一个颜色：

- **光标行颜色** —— 可任选颜色；留空则跟随光标色（浅色主题棕色，深色主题橙色）。
- **光标行强度** —— 一个滑块统一控制行号色块与色带的浓度。

色带由光标行颜色的半透明变体生成，而不是固定的灰色阴影，所以它能和背景融合，不会像「另加了一层颜色」。

### 实现细节

Obsidian 的编辑器从不标记当前行的行号，CSS 没有可选中目标。插件现在注册了 CodeMirror 的 `highlightActiveLineGutter` 扩展，给当前行号加上 `.cm-activeLineGutter` 类。该类只在「光标行」背景部分开启时才会上色，所以关闭该功能的用户不受影响。

---

## English

### Cursor line: line-number chip, optional pseudo-3D band, and a colour picker

The cursor line used to be a single warm background across the whole line. In 1.24.14 it is split into two signals you control separately:

- **Line-number chip** — the cursor line's line number gets a coloured chip in the gutter. It sits outside the text, so the current line is always identifiable without painting anything over the body.
- **Pseudo-3D band** — optional, and on by default. A light top edge, a dark bottom edge and a faint gradient make the line look slightly raised. Turn it off in *Settings → Background → Pseudo-3D band* if a band following the caret feels tiring to your eyes.

Both signals use the same colour:

- **Cursor line colour** — pick any colour; leave it empty to follow the caret colour (brown in light themes, orange in dark ones).
- **Cursor line strength** — one slider scales the line-number chip and the band together.

The band is derived from the cursor-line colour (translucent tints of it) rather than a fixed grey shadow, so it blends with the background instead of looking like a foreign colour laid on top.

### Under the hood

Obsidian's editor never marks the cursor's line number, so CSS had nothing to target. The plugin now registers CodeMirror's `highlightActiveLineGutter` extension, which adds `.cm-activeLineGutter` to the current line's number. The class is painted only while the *Cursor line* background part is enabled, so nothing changes for users who keep it off.
