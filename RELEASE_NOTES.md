# 1.24.29

## 中文

维护版本：界面无变化，清掉社区审核的最后一条 `prefer-create-el` 警告。

- **fragment 改由 `createFragment()` 提供**：10 处游离的虚拟链接元素仍走 `createDetached`，但接收者不再是 `activeDocument.createDocumentFragment()`，而是 Obsidian 的全局助手 `createFragment()`。上一版因为「在 document 上调用 `create*`」被审核标记（`linker/virtualLinkMatch.ts:40`），那一行现在只剩一次 `createFragment()` 调用。
- **语义不变**：`createEl` 仍把元素 append 到随手丢掉的 fragment 上，元素依旧游离（由 CodeMirror 接收后再挂载），也不会踩「Document 接收者」导致的 `HierarchyRequestError: Only one element on document allowed`。
- **无行为变化**：界面逻辑与 1.24.28 一致。

## English

Maintenance release: nothing changes on screen, the last `prefer-create-el` warning from the community review is cleared.

- **The fragment now comes from `createFragment()`**: the ten detached virtual-link elements still go through `createDetached`, but the receiver is no longer `activeDocument.createDocumentFragment()` - it is Obsidian's global `createFragment()` helper. The previous release was flagged for calling a `create*` method on the document (`linker/virtualLinkMatch.ts:40`); that line is now a single `createFragment()` call.
- **Same semantics**: `createEl` still appends the element to a throwaway fragment, so the element stays detached (CodeMirror receives it built and appends it afterwards) and the "Document receiver" case that throws `HierarchyRequestError: Only one element on document allowed` is still avoided.
- **No behaviour change**: the on-screen logic is the same as 1.24.28.
