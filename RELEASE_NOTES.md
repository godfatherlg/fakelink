# 1.24.27

## 中文

维护版本：界面没有任何变化，只把代码整理成社区审核要求的形式。

- **元素创建改用专用助手**：5 处 `createEl('div', …)` 改为 `createDiv(…)`，1 处 `createEl('span', …)` 改为 `createSpan(…)`。两者在 Obsidian API 中就是对应标签的简写，返回值类型更精确，行为不变。
- **虚拟链接的 span 保留原写法，并就地注明原因**：10 处 `activeDocument.createElement(...)` 必须保持「游离」（由 CodeMirror 接收后再挂载），并且必须建于 `activeDocument`（悬浮预览可能位于第二个窗口）。若改用 `createEl`，元素会被立即插入到接收者；而部分插件（如 Media Extended）替换了该助手，会抛出 `HierarchyRequestError: Only one element on document allowed`。这些调用点已加注释说明，供审核复核。
- **无行为变化**：`main.js` 的界面逻辑与 1.24.26 完全一致。

## English

Maintenance release: nothing changes on screen, the code is only brought into the shape the community review asks for.

- **Element creation uses the dedicated helpers**: 5 `createEl('div', …)` calls became `createDiv(…)` and 1 `createEl('span', …)` became `createSpan(…)`. They are the documented shorthands for those two tags, with narrower return types and no behaviour change.
- **The virtual-link spans keep their current form, now documented in place**: 10 `activeDocument.createElement(...)` calls must stay detached (CodeMirror receives them built, then appends them) and must be forged on `activeDocument` (a hover preview can live in a second window). Using `createEl` there would append the element to the receiver immediately, and plugins that replace that helper (Media Extended) throw `HierarchyRequestError: Only one element on document allowed`. Those call sites now carry that reasoning inline for the review.
- **No behavioural change**: the interface logic in `main.js` is identical to 1.24.26.
