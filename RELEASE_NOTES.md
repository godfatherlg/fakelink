# 1.24.17

## 中文

### 代码清理

- 移除 `liveLinker.ts` 中三处多余的类型断言（`closest()` 的返回类型已足够），并把搜索跟踪容器的类型相应调整为 `Element | null`。
- 用 Obsidian 官方的 `Node.instanceOf(HTMLElement)` 替换 `instanceof HTMLElement`，在跨窗口环境下更安全。
- 无功能变化。

---

## English

### Code cleanup

- Removed three unnecessary type assertions in `liveLinker.ts` (the `closest()` return type is already correct) and adjusted the search tracker container type to `Element | null` accordingly.
- Replaced `instanceof HTMLElement` with Obsidian's `Node.instanceOf(HTMLElement)` for cross-window safety.
- No functional changes.
