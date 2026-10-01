# 1.24.8

## 中文

**兼容与代码质量**

- **修复**：定时器改用 `window.setTimeout`，保证弹出窗口（popout）中的悬停预览正常工作
- **修复**：弃用的 `activeLeaf` 已替换为 `getMostRecentLeaf()`，Canvas 检测不再依赖已弃用 API
- **修复**：文件排除检查改用 `instanceof TFile` 类型窄化，替代不安全的类型强转

## English

**Compatibility & code quality**

- **Fix**: timers now use `window.setTimeout`, so hover previews keep working in popout windows
- **Fix**: the deprecated `activeLeaf` is replaced with `getMostRecentLeaf()`, so Canvas detection no longer relies on the deprecated API
- **Fix**: the file-exclusion check narrows the type with `instanceof TFile` instead of an unsafe cast
