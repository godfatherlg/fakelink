# 1.24.20

## 中文

纯代码清理，无行为变化。

- 链接内搜索高亮使用的文本节点改用 Obsidian 的 `appendText` 辅助方法创建，替代 `document.createTextNode`。至此 `linker/liveLinker.ts` 中不再包含 `createElement` / `createTextNode`，消除了该文件在 `obsidianmd/prefer-create-el` 规则下的全部警告。

## English

Pure code cleanup, no behaviour change.

- The text nodes used by the in-link search highlight are now created with Obsidian's `appendText` helper instead of `document.createTextNode`. `linker/liveLinker.ts` no longer contains any `createElement` / `createTextNode` call, clearing every `obsidianmd/prefer-create-el` warning for that file.
