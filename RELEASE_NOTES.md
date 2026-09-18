# 1.23.27

## 中文

- **内部整理（社区插件审核反馈，第二轮）**：元素创建统一改用 Obsidian 的 `createEl`；类名在创建时一并传入（不再用 `addClass`）；尺寸缓存的读写不再依赖 `Object.fromEntries` / `Object.entries`（审核环境的 TypeScript 库不含这两个 API，会被判为 `any`）。
- **本版本没有功能变化** —— 跳转、悬停预览、尺寸预留、标题对齐、批量转换的行为都与 1.23.26 一致。如果你没有遇到问题，可以跳过它。

## English

- **Internal cleanup from the second community-plugin review pass**: elements are now created through Obsidian's `createEl`, classes are passed at creation time instead of via `addClass`, and the size cache no longer uses `Object.fromEntries` / `Object.entries` (the reviewer's TypeScript lib does not include them, which made their results `any`).
- **No functional changes** - jumps, hover previews, size reservation, heading alignment and batch conversion all behave exactly as in 1.23.26. Skip this one unless you are curious.
