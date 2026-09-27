# 1.23.47

## 中文

**修复：Hover Editor 悬浮窗口会让精准匹配变成模糊匹配**

悬浮窗口获得焦点后，`workspace` 的"当前文件"变成窗口里打开的那篇。主笔记渲染时若拿不到自己的文件映射，会回退用"当前文件"做排除 —— 于是窗口里那篇被当成"自己"排除掉，指向它的精准匹配消失，只剩模糊匹配。

现在缺失映射时优先使用最后一个真实（非悬浮）视图的文件；连它也未知时不排除任何文件。

**改动：跳转后标题对齐改为"保持位置"（防漂移）**

跳转到标题后，Obsidian 本来就把标题放到了居中位置 —— 点击真实链接可以验证它放得又准又稳。旧实现对那个位置再做一次"按插件自己的居中公式"的修正，反而把正确的位置挤偏（在公式较多的笔记里尤其明显）。

新行为：

- 跳转后首次检查只**记录** Obsidian 放置的位置作为基准，绝不对它二次调整；
- 之后仅当内容变化把标题推离基准时（PDF 嵌入、图片、整页公式在几秒后才渲染完成），才把标题放回基准位置；
- 该功能默认关闭，新设置「跳转后保持标题位置」；「标题对齐观察窗」只在它打开时显示。

**居中判定的完善**（仅开启上述开关时参与）：

- MathJax 排版期间视为"仍在渲染"（以公式容器数量变化为信号），不再在布局移动时出手；
- 连续两次写入没有让标题更接近目标就停止 —— 一个赢不了的循环不应该拉扯视图；
- 移除了基于位置的 `scrollIntoView` 方案：实测（`scrollTop` 拦截）确认它才是"居中后又被挤下去"的来源 —— 它按估算的位置居中，而公式排版期间估算会偏出近千像素。

## English

**Fixed: Hover Editor focus turned exact matches into fuzzy ones**

When a Hover Editor window takes focus, the workspace's "current file" becomes the note opened in it. If the main note's renderer could not resolve its own file mapping it fell back to that "current file", which excluded the hovered note as if it were self - so keywords pointing at it lost their exact match and fell back to fuzzy.

A missing mapping now prefers the last real (non-floating) view's file, and excludes nothing when even that is unknown.

**Changed: post-jump heading alignment is now "hold the position" (drift protection)**

After a jump, Obsidian already puts the heading at the centred position - clicking a real link proves it lands exactly there. The old pass re-adjusted that position with the plugin's own idea of "centred", which dragged correctly-placed headings off (most visible in notes full of display math).

New behaviour:

- The first check only RECORDS where the jump left the heading, as the baseline. It is never re-adjusted.
- Afterwards, only when content changes push the heading away from that baseline (a PDF embed, an image, a page of display math finishing seconds later) is it put back.
- Off by default, as the new setting "Align heading after jump"; the "Heading align watch window" slider only appears while it is on.

**Alignment refinements** (only active with the switch above):

- MathJax typesetting now counts as "still rendering" (signalled by the count of formula containers changing), so corrections no longer fire mid-layout;
- Two writes in a row that do not move the heading closer stop the loop - a loop that cannot win must not tug at the view;
- Removed the position-based `scrollIntoView` approach: a `scrollTop` hook on a math-heavy note showed it was the source of "centred then pulled down" - it centres a position, and while math re-typesets that position's on-screen estimate drifts by hundreds of pixels.
