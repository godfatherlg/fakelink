# 1.24.4

## 中文

**修复**

- **修复**：更新说明（What's new）在应用语言为中文时现在会显示中文；1.24.3 中误显示为英文（新写的条目漏登记进翻译表）。本次仅修正本地化，功能修复（预览时标题链接丢失）已在 1.24.3 发布

## English

**Fix**

- **Fix**: the What's-new notes now display in Chinese when the app language is Chinese; 1.24.3 showed them in English (the new entry was missing from the translation table). This release only fixes localization; the functional fix (heading links lost while previewing) shipped in 1.24.3

# 1.24.3

## 中文

**修复**

- **修复**：当某个笔记正在预览、而另一个笔记处于激活状态时，被预览的笔记里指向激活笔记标题的链接会消失，并被显示为模糊匹配的颜色。原因是「标题不链接到自己的笔记」这条规则误用了编辑器里激活的笔记（activeFile），而非正在渲染的笔记（mappedFile）。现已让精确/模糊的判定依据改为「正在渲染的笔记」，覆盖编辑、阅读与批量转换三条渲染路径

## English

**Fix**

- **Fix**: when a note was being previewed while a different note held focus, the previewed note's links pointing at the focused note's headings disappeared and were shown in the fuzzy-match colour. The "a heading must not link to its own note" rule wrongly used the editor's active file instead of the note actually being rendered; the exact/fuzzy decision now uses the rendered note, across the edit, reading and batch-convert paths


