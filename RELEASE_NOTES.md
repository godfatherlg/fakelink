# 1.24.30

## 中文

新增功能与两处修复。

- **新增开关「允许链接到当前笔记的标题」**（设置 → 标题组，默认关闭）：正文里的词可以链接到本篇笔记自身的标题。此前这条规则是写死的，任何设置都关不掉，因此「笔记里写 `## 术语`、正文再提到该术语」永远不生成链接（issue #25）。
  - 生效前提：需开启「包含标题」；**「排除指向自身的链接」开启时本开关不生效**（该开关会先把本篇整篇剔出候选，优先级更高）。两个前提不满足时开关自动置灰并注明原因。
  - 标题行本身仍然不会链接到自己（否则标题文字会被替换、标题消失），编辑视图与阅读视图都保留这一保护。
  - 只影响「标题」这一类：笔记名、别名的自链接仍由「排除指向自身的链接」控制。
- **修复：视口大跳时链接短暂消失**。拖动滚动条、点链接跳转、切换笔记这类视口大跳，此前会先清空链接、约 150ms 后（防抖结束）才补画，肉眼看到的是「闪一下」。现在重建与视口更新在同一次 update 内完成，空窗消失；实测 131KB / 59 个链接的笔记连续快速滚动 3 秒：60fps、无长任务、无掉帧。
- **修复：改匹配设置后已打开的笔记不刷新**。重建后的 decorations 没有随之 dispatch，CodeMirror 不会重读，表现为「改了设置没反应，得先动一下文档」。现在设置变更后立即生效。

## English

One new option and two fixes.

- **New toggle "Allow links to headers in the current note"** (Settings -> Headers, off by default): a word in the body can link to a heading of the note it is written in. The rule used to be hard-coded and could not be turned off, so `## Term` plus a body mention of `Term` never produced a link (issue #25).
  - Requirements: "Include headers" must be on; the toggle has **no effect while "Exclude self-links to the current note" is on**, because that option drops the whole note from the candidates first. The toggle is greyed out with an explanation when either requirement is missing.
  - A heading line still never links to itself (the decoration would replace the heading text and the heading would vanish); the guard is kept in both the edit and the reading view.
  - Only header matches are affected - note-name and alias self-links are still controlled by "Exclude self-links to the current note".
- **Fix: links no longer vanish when the viewport jumps.** Dragging the scrollbar, following a link or switching notes used to clear the links and repaint them about 150 ms later (after the scroll debounce), which read as a blink. The rebuild now happens in the same update as the viewport change. Measured on a 131 KB note with 59 links, three seconds of continuous fast scrolling: 60 fps, no long tasks, no dropped frames.
- **Fix: changing a matching setting did not refresh the open note.** The rebuilt decorations were not dispatched, so CodeMirror kept the old set until the next keystroke. Settings now take effect immediately.
