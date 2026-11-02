# 1.24.22

## 中文

修复 issue #24：在行首输入 `|` 创建表格时，后续按键被吞掉。

- 原因：1.24.16 起，搜索跟踪把 `input` / `keydown` 监听挂在整个编辑器上，编辑器里的每次输入都会触发装饰重建并 dispatch 一个空事务，打断了 Obsidian 自己的输入处理（`|` 切换表格时最明显）。
- 修复：这两个监听现在只响应搜索面板（`.document-search-container`）内部的输入，编辑器输入（包括表格）不再触发重建。

## English

Fixes issue #24: typing `|` at the start of a line (creating a table) swallowed every keystroke after it.

- Cause: since 1.24.16 the search tracking attached its `input` / `keydown` listeners to the whole editor, so every keystroke triggered a decoration rebuild that dispatched an empty transaction - interrupting Obsidian's own input pipeline (most visible when `|` switches a line into a table).
- Fix: those listeners now only react to input inside the search panel (`.document-search-container`), so typing in the editor - tables included - no longer triggers a rebuild.
