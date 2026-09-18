# 1.23.29

## 中文

- **修复：标题被上方内容"挤走"的根本原因。** 此前插件会把自己**预留的高度**（一个估计值）**当成实测高度记录下来**，于是每次打开都用同一条错误值预留、渲染完成后再撤销 —— 标题因此**每次**都被顶偏。现在改为**先撤销预留、再测量真实高度**；同时作废了此前可能被污染的高度缓存（会按正确方式重新学习）。
- **修复：指向"带空格的标题"的虚拟链接会落错位置**（例如 `#1. 一般正态分布的概率公式`）。链接片段过去被转成全小写、空格变短横线的 slug，Obsidian 无法据此找到标题。现在片段就是**标题原文**，并且仍兼容旧的 slug 形式。
- **修复：在编辑器里点击虚拟链接时，很晚才渲染的图片/PDF 造成的偏移不会被纠正。** 这条路径过去只在 3 秒、8 秒各"重新跳转"一次，而且"只要标题还看得见就跳过"；现在改为**实测对齐**（沿用你设置的观察窗），可以覆盖任意晚到的变化。
- **改进：标题对齐改为事件驱动。** 只要标题上方内容的高度发生变化（PDF/图片渲染完成、公式排版完成），就**立刻**把标题摆回原位；页面静止时**不做任何轮询**。观察窗（秒）仍是最长跟随时间。
- **改进：两处等待设置统一为"秒"** ——「标题对齐观察窗（秒）」与「行跳转等待上限（秒）」（原名「跳转延时（毫秒）」）。**旧值自动迁移，行为不变**（例如 8000 毫秒 ⇒ 8 秒），设置说明也同步改写，不再出现毫秒与换算式。

## English

- **Fix: the root cause of a heading being pushed away by the content above it.** The plugin used to record its own **reserved height** (a guess) as if it had been measured, so every visit reserved the same wrong value and released it again - pushing the heading out of place **on every single visit**. Reservations are now **released before measuring**, and the previously poisoned size cache is discarded so heights are learned correctly.
- **Fix: virtual links pointing at a heading that contains spaces landed in the wrong place** (e.g. `#1. Normal distribution`). The fragment used to be lowercased with spaces turned into dashes, which Obsidian cannot resolve back to a heading. The fragment is the **heading text** again, and the old slug form is still accepted.
- **Fix: clicking a virtual link inside the editor ignored offsets caused by very late images/PDFs.** That path only re-navigated at 3 s and 8 s, and skipped it whenever the heading was still visible; it now runs the measured alignment for the whole watch window, so arbitrarily late changes are covered.
- **Improved: heading alignment is event-driven.** The heading is put back in place the moment the content above it changes height; while the page is quiet nothing polls. The watch window (seconds) remains the maximum time to follow.
- **Improved: both wait settings are in seconds now** - "Heading align watch window (seconds)" and "Line jump wait limit (seconds)" (was "Jump delay (ms)"). Existing values are migrated automatically and the behaviour is unchanged (8000 ms => 8 s). Their descriptions were rewritten as well, so no milliseconds or conversion formulas remain.
