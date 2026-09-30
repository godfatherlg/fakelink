# 1.23.57

## 中文

**内部整理（续）：功能完全不变**

承接上一版的重构，这次把「行跳转」（`obsidian://adv-uri` 相关的处理）从 `main.ts` 搬到了独立模块 `src/lineJump.ts`。

- **没有任何行为变化** —— 复制链接、点击跳转、行号自愈都和上一版一致
- `main.ts` 从 2408 行降到 2115 行
- 仍然只是为了可维护性，不是功能更新

## English

**Internal cleanup, continued: no behaviour changes**

Following on from the previous release, line jumping (the `obsidian://adv-uri` handling) moved out of `main.ts` into its own module, `src/lineJump.ts`.

- **Nothing behaves differently** — copying a link, jumping to a line and self-healing line numbers all work exactly as before
- `main.ts` went from 2408 to 2115 lines
- Again: maintainability only, not a feature change
