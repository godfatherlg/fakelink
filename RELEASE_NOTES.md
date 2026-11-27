# 1.24.37

## 中文

阅读视图的「只链一次」现在和编辑视图**完全一致**，判据都来自整篇笔记文本。

- **阅读视图按整篇判断**：每个段落渲染时都能拿到整篇文本和本段首行，于是先查「这个词在段前是否已经出现过」，再查「本段已渲染的前缀里是否已经出现过」。两条都不成立才生成链接，不再依赖任何跨渲染记账。
- **修掉的表现**：跨段重复时每段各链一次（一篇 2 段 × 2 次的两个标题，阅读视图原本 4 个链接，现在 2 个）；callout 与正文相互看不见；短词、行首空格、重复行在阅读视图与编辑视图结果不一致。
- **删除阅读视图的「已链接」记账**：这套记账也是之前「整篇笔记渲染后一个链接都没有」的来源，一并去掉。
- 编辑视图逻辑未改动；实时预览里的 callout 仍走原来的文本定位（那段刚刚修过，不回退）。
- 实测对照（同一批笔记，编辑 vs 阅读）：正文在前 1/1、callout 在前 1/1、双标题 2/2、三字词 2/2、行首全角空格 1/1、加粗列表 1/1、关闭开关 7/7。
- 47 条单元测试通过（新增行号与段内前缀两条）；`npx eslint .` 无报错。

## English

"Only link once" now behaves **exactly the same** in the reading view and the editor: both decide from the note text.

- **The reading view decides from the whole note**: while a section renders, Obsidian hands it the whole note text plus the section's first line, so it can first ask "did this keyword already appear before this section?" and then "did it already appear in the rendered prefix of this section?". A link is created only when both answers are no - no cross-render bookkeeping is involved.
- **What this fixes**: a keyword repeated in a later paragraph was linked once per paragraph (a two-heading glossary with two mentions each produced 4 links in the reading view instead of 2); callouts and the body did not see each other; short words, leading spaces and repeated lines disagreed between the two views.
- **The reading view's "already linked" ledger is removed** - it was also the source of the earlier "whole note renders with no links" problem.
- The editor is untouched; callouts in Live Preview keep their text-based lookup (recently fixed, no regression).
- Measured with the same notes, edit vs reading view: body first 1/1, callout first 1/1, two-heading glossary 2/2, three-character keyword 2/2, leading ideographic space 1/1, bold list 1/1, option off 7/7.
- 47 unit tests pass (two new: line offsets and section-prefix detection); `npx eslint .` is clean.
