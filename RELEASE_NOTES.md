# 1.23.33

## 中文

- **新增：设置 → 外观 → 「背景」（默认关闭）。** 一个开关控制一整套可选的阅读外观，配色沿用自定义 CSS 片段的常见做法，打开即生效、关掉即恢复原样：
  - 很淡的整体底色（默认 `#f0f8ff`，并同步主题的 `--background-*` 变量）；
  - **列表行**、**以 Tab 缩进的行（连同它上面的一行）**、**表格**、**调用块** 都得到淡蓝色背景（`rgba(135, 206, 235, 0.1)`）；
  - 光标所在行暖橙色高亮（`rgba(255, 220, 180, 0.35)`）+ 深棕色光标（`#8B4513`）；
  - 激活标签页带强调条与渐变底，非激活标签页/面板只**轻微**变暗（`0.9 / 0.85`）；
  - 窗口**失焦**时工作区蒙一层很轻的暗色（`rgba(0, 0, 0, 0.25)`，不再像原来那样 70% 黑）。
- **Tab 缩进行只能由插件来做**：Obsidian 里这类行不带任何类名，纯 CSS 片段选不到；现在由插件用编辑器装饰器标记后再着色 —— 这是以前用 CSS 做不到的部分。
- **深色主题另有一套配色**（深底 + 亮蓝行底 + 亮橙光标行 + 深色蒙版），切换主题无需任何手动调整。
- **阅读模式同样生效**：列表、表格、调用块都会着色（阅读模式里的 Tab 缩进在渲染时已被折成空格、信息丢失，因此那里无法识别，这一点和 CSS 片段时代一致）。
- 所有颜色都是 CSS 变量（`--fakelink-bg`、`--fakelink-line-bg`、`--fakelink-cursor-line-bg`、`--fakelink-caret`、`--fakelink-tab-accent`、`--fakelink-tab-bg`、`--fakelink-tab-pane`、`--fakelink-unfocused-mask`），可用片段覆盖微调。
- 不开这个开关时，插件行为与 1.23.32 完全一致。

## English

- **New: Settings - Appearance - "Background" (off by default).** One switch for a complete optional reading look, matching what custom CSS snippets usually do - it applies instantly and reverts completely when turned off:
  - a very faint overall tint (default `#f0f8ff`, also mapped onto the theme's `--background-*` variables);
  - a light blue background on **list lines**, on **lines indented with a Tab (together with the line above them)**, on **tables** and on **callouts** (`rgba(135, 206, 235, 0.1)`);
  - a warm orange highlight on the cursor line (`rgba(255, 220, 180, 0.35)`) with a dark brown caret (`#8B4513`);
  - the active tab header gets an accent bar and a gradient, while inactive tabs/panes are only **gently** dimmed (`0.9 / 0.85`);
  - while the window is **unfocused**, a very light mask covers the workspace (`rgba(0, 0, 0, 0.25)` instead of the 70% black a snippet would use).
- **Tab-indented lines need the plugin**: Obsidian gives those lines no class at all, so a CSS snippet cannot select them; the plugin now marks them with an editor decoration and styles them. That part was simply not possible with CSS.
- **Dark themes get their own palette** (dark base, brighter blue line tint, orange cursor line, darker mask), so switching theme needs no manual tuning.
- **The reading view is covered too**: lists, tables and callouts are tinted. (Tab indentation is collapsed to spaces before it reaches the reading view, so it cannot be detected there - same limitation as with a CSS snippet.)
- Every colour is a CSS variable (`--fakelink-bg`, `--fakelink-line-bg`, `--fakelink-cursor-line-bg`, `--fakelink-caret`, `--fakelink-tab-accent`, `--fakelink-tab-bg`, `--fakelink-tab-pane`, `--fakelink-unfocused-mask`) and can be overridden from a snippet.
- With the switch off, the plugin behaves exactly like 1.23.32.
