# 1.23.24

## 中文

- **修复：跳转到标题后位置不准**。标题上方的内容（公式、图片、PDF++ 裁剪嵌入等）在跳转完成后仍会继续改变高度，把标题顶偏 —— 常见表现是标题只剩半行、或者整体偏上。现在跳转后会在**编辑器、悬停预览弹窗、阅读模式**三处持续把标题保持在顶部附近，直到布局稳定；你一旦滚动 / 按键 / 点击，立刻让位。
- **修复：重建索引失败会让该文件在索引里的条目被整段清空** ⇒ 所有指向它的链接从精确匹配退化成模糊匹配。现在会重试一次，仍失败则显式上报，不再静默清空。
- **修复：悬停预览会打断底下编辑器的输入焦点**，或在鼠标移动时提前关闭。
- **新增：设置 → 外观 →「虚拟链接不触发悬停预览」**（默认关闭）。开启后虚拟链接不再弹出页面预览 / Hover Editor；点击跳转仍然正常。
- **新增：设置 →「跳转后标题距顶部间距（像素）」**（默认 32）。悬停弹窗自带标题栏压住内容、或觉得标题太靠上时调大它。
- **变更：「标题跳转重试延时（毫秒）」改名为「标题对齐观察窗（毫秒）」**。三次重新跳转已移除，改为控制跳转后持续对齐的时长（该值 ×24，最少 8 秒，即 500 表示 12 秒）。

## English

- **Fix: a jump to a heading could land in the wrong place.** Content above the heading (formulas, images, PDF++ crops) keeps changing height after the jump, pushing the heading out of position - typically leaving only half a line visible, or landing too high. The heading is now kept near the top of its pane in the **editor, hover previews and the reading view** until the layout settles; scrolling, pressing a key or clicking hands control straight back to you.
- **Fix: a failure while re-indexing a file cleared all of that file's index entries**, so every link pointing at it silently degraded from an exact match to a fuzzy match. Re-indexing now retries, and reports the error if it still fails.
- **Fix: hover previews could steal the editor's focus**, or close early while the mouse moved.
- **New: Settings - Appearance - no hover preview for virtual links** (off by default). Virtual links stop opening the page preview / Hover Editor popover; clicking still navigates.
- **New: Settings - heading top gap after a jump (px)**, default 32. Increase it when a hover popover draws its own header over the content, or when the heading looks too close to the top.
- **Changed: header jump retry delay (ms) is now heading align watch window (ms).** The three re-navigations are gone; it controls how long a jumped-to heading keeps being re-aligned (24x the value, minimum 8 seconds, so 500 => 12s).
