# 1.24.19

## 中文

纯代码清理，无行为变化。

- 搜索时隐藏 `**` / `*` / `==` / `~~` 等行内格式标记的 CSS 规则去掉了 `!important`，改用选择器特异性实现（Obsidian 自身对显示状态的行内标记没有竞争样式，因此无需强制覆盖）。
- 链接内搜索高亮的 span 改用 Obsidian 的 `createEl` 辅助方法创建，替代 `document.createElement`。

## English

Pure code cleanup, no behaviour change.

- The CSS rule that hides inline formatting markers (`**` / `*` / `==` / `~~`) while searching no longer uses `!important`; selector specificity does the job (Obsidian has no competing rule on inline markers in their visible state).
- The spans that draw the in-link search highlight are now created with Obsidian's `createEl` helper instead of `document.createElement`.
