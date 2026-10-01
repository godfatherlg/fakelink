# 1.24.3

## 中文

**修复**

- **修复**：当某个笔记正在预览、而另一个笔记处于激活状态时，被预览的笔记里指向激活笔记标题的链接会消失，并被显示为模糊匹配的颜色。原因是「标题不链接到自己的笔记」这条规则误用了编辑器里激活的笔记（activeFile），而非正在渲染的笔记（mappedFile）。现已让精确/模糊的判定依据改为「正在渲染的笔记」，覆盖编辑、阅读与批量转换三条渲染路径

## English

**Fix**

- **Fix**: when a note was being previewed while a different note held focus, the previewed note's links pointing at the focused note's headings disappeared and were shown in the fuzzy-match colour. The "a heading must not link to its own note" rule wrongly used the editor's active file instead of the note actually being rendered; the exact/fuzzy decision now uses the rendered note, across the edit, reading and batch-convert paths


