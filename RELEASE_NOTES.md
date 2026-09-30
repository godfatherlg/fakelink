# 1.23.58

## 中文

**内部整理（续）：功能完全不变**

承接前两版，这次把「右键菜单」从 `main.ts` 搬到了独立模块 `src/contextMenu.ts`。

- **没有任何行为变化** —— 文件/文件夹、虚拟链接、编辑器里的右键菜单项和上一版完全一致
- `main.ts` 从 2115 行降到 1859 行（本轮重构累计从 2237 降下来）
- 仍然只是为了可维护性

## English

**Internal cleanup, continued: no behaviour changes**

Following the previous releases, the right-click menu moved out of `main.ts` into its own module, `src/contextMenu.ts`.

- **Nothing behaves differently** — the menu items for files/folders, virtual links and the editor are exactly as before
- `main.ts` went from 2115 to 1859 lines (2237 at the start of this cleanup)
- Again: maintainability only
