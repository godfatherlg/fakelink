# 1.24.34

## 中文

维护版本：界面无变化，清掉社区审核剩下的两条警告和一条建议。

- **不再有 any 类型**：阅读视图里查找所属编辑器时，原来用 `as unknown as {...}` 强转，"unsafe call / unsafe member access" 两条警告就来自这里。现在改成 `instanceof MarkdownView` 收窄类型，`editor.getValue()` 是完整类型。
- **删除未使用的导入**：`src/batchConvert.ts` 里残留的 `IntervalTree`（把排除区间扫描抽到 `linker/excludedIntervals.ts` 之后不再使用）。
- **删除废弃的设置标志**：`settingsTab` 里的 `needsFullUpdate` 在取消自动联动后已无赋值点，改为直接刷新可见/禁用状态。
- 无行为变化：`npx eslint .` 0 错误 0 警告，45 条单元测试通过，callout 与只链一次的运行时用例复测一致。

## English

Maintenance release: nothing changes on screen; the last two warnings from the community review and one recommendation are cleared.

- **No any-typed values** in the reading-view path: it used to locate the owning editor through an `as unknown as {...}` cast, which is where the "unsafe call / unsafe member access" warnings came from. It now narrows with `instanceof MarkdownView`, so `editor.getValue()` is fully typed.
- **Removed an unused import**: the leftover `IntervalTree` in `src/batchConvert.ts` (no longer used after the exclusion scan moved to `linker/excludedIntervals.ts`).
- **Removed a dead settings flag**: `needsFullUpdate` in `settingsTab` had no assignment left after the automatic coupling was dropped; the visible/disabled state is refreshed directly now.
- No behaviour change: `npx eslint .` reports 0 errors and 0 warnings, 45 unit tests pass, and the callout / only-link-once runtime cases were re-checked.
