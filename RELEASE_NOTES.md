# 1.23.49

## 中文

**「对齐标题」重做：覆盖跳转与悬浮预览，语义统一为"让标题保持在中间"**

新设置「对齐标题（跳转与预览）」（默认关闭）同时覆盖两条路径：

- **跳转**：把目标标题移到视口中间。之前这里是"守住跳转落点"，但虚拟链接使用的 `openLinkText` 落点是那一行本身（往往在顶部附近），守住的正是错误位置 —— 这就是"跳转后标题顶置"的原因。
- **悬浮预览**：弹窗按"链接"所在位置打开，标题常常并不在中间，同样主动居中。之前这条路径还不在设置控制之内（关了设置预览行为也不变）。

关闭该设置时，跳转与预览完全不干预 —— 与点击真实链接的表现一致。

**对齐逻辑的修正**：

- 容差从 6px 放宽到 24px：内容落定带来的 10px 级位移不再触发修正 —— 修正本身伴随一次滚动，比 10px 的偏移更扰人。
- MathJax 排版期间视为"仍在渲染"（以公式容器数量变化为信号），不再在布局移动中出手。
- 插件自己造成的布局变化（嵌入块高度的预留与释放）会被标记并跳过，不再被当作真实漂移去"修正"。
- 写入自检只在页面静止时判定成败：公式排版期间"没有改善"只是布局又动了，之前被当作失败导致循环过早放弃 —— 这正是"预览有时明显不居中"的原因。
- 基准（跳转落点）改为等页面静止后才记录：跳转分两步（装载文档 → 应用滚动），过早读取会拿到跳转中途的位置。
- 修复：hover 一个不带标题的链接后，之前记录的标题 id 不再残留到下一个预览。

**内置对齐调试日志**

`window.__fakelinkDebug = true` 后，控制台会输出对齐流程的完整轨迹（是否找到标题、当前位置与目标、是否执行修正）。这次的问题就是靠它一次定位的，留着以便日后排查。

## English

**"Align heading" reworked: covers jump and hover preview, one goal - the heading stays centred**

The new setting "Align heading (jump and preview)" (off by default) covers both paths:

- **Jump**: moves the target heading to the middle of the pane. It used to "hold the landing spot" - but the landing spot of `openLinkText` (what virtual links call) is the ROW itself, usually near the top, so holding it held the wrong place. That is why jumped-to headings ended up parked at the top.
- **Hover preview**: a popover opens at the position of the LINK, so the heading is often nowhere near the middle - it is now centred outright. This path also was not covered by the setting at all (turning it off changed nothing on previews).

With the setting off, jumps and previews are left completely alone - matching what clicking a real link does.

**Alignment fixes**:

- Tolerance widened from 6px to 24px: a 10px drift from content settling no longer triggers a correction (which costs a scroll and is more distracting than the drift).
- MathJax typesetting now counts as "still rendering" (signalled by the count of formula containers changing), so corrections no longer fire mid-layout.
- Layout changes the plugin causes itself (reserving and releasing an embed's height) are now marked and skipped, instead of being treated as real drift to correct.
- The write self-check only judges results while the page is holding still: during math typesetting "no improvement" just means the layout moved again, and counting those as failures made the loop give up early - which is how previews could end up visibly off-centre.
- The jump baseline is recorded only after the surface settles: a jump is two steps (load the document, then apply the scroll), and reading in between captured a mid-jump position.
- Fixed: hovering a link without a heading no longer leaves the previous heading id behind for the next preview.

**Built-in alignment trace**

Set `window.__fakelinkDebug = true` and the console shows the full alignment trail (heading found or not, current vs target position, whether a correction ran). This release's bug was located with exactly that, in one pass - it stays in for future diagnosis.
