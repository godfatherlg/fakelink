# 1.23.40

## 中文

**代码审核修复**
- 改用 `window.requestAnimationFrame()`，提升弹出窗口（popout window）兼容性。
- 移除未使用的路径工具函数（`main.ts` 里的 `dirname` / `basename` / `relative`）与两处多余的类型断言。
- 补充注释说明：虚拟链接元素按设计使用原生 `createElement` 创建（必须保持 detached，交由 CodeMirror 插入），以兼容会替换 `createEl` helper 的插件。
- 补充注释说明剪贴板用途：仅用于用户主动触发的「复制行链接」命令（只写不读）。

## English

**Review fixes**
- Use `window.requestAnimationFrame()` for popout-window compatibility.
- Removed unused path helpers (`dirname` / `basename` / `relative` in `main.ts`) and two redundant type assertions.
- Documented why virtual-link elements are built with the native `createElement`: they must stay detached until CodeMirror inserts them, which also avoids conflicts with plugins that replace the `createEl` helper.
- Documented the clipboard use: it is limited to the user-invoked "copy line link" command (write-only).
