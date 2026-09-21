# 1.23.38

## 中文

**重构**
- 设置面板整体抽取到独立文件 `src/settingsTab.ts`，`main.ts` 精简约 700 行（纯移动，无行为变化）。

**表格支持优化**
- 修复：加载插件后，渲染表格里的虚拟链接不出现（需删一个字才触发）的问题。
- 修复：表格高亮（`==高亮==`）里的虚拟链接底色叠加变深、颜色不一致的问题。
- 修复：表格里的虚拟链接「转真实链接」定位错误（点进单元格时报错、转错位置、被 `|` 拆列）的问题。
- 重写表格转换定位：删除约 450 行旧的 `handleTableCellConversion`，改用简洁的 DOM 行列定位，表格内外共用同一条转换路径。
- 表格表头里的虚拟链接保持加粗样式。

## English

**Refactor**
- The settings panel was extracted into its own file `src/settingsTab.ts`, slimming `main.ts` by ~700 lines (pure move, no behavior change).

**Table support**
- Fixed: virtual links in rendered tables did not appear after loading (required deleting a character first).
- Fixed: virtual links inside table highlights (`==highlight==`) stacked a darker, inconsistent background.
- Fixed: "Convert to real link" in tables landed in the wrong place (error while editing a cell / wrong position / broken by the `|` separator).
- Rewrote table conversion positioning: removed ~450 lines of the old `handleTableCellConversion`, replaced by concise DOM row/column positioning shared across contexts.
- Table header virtual links keep their bold styling.
