# 1.24.16

## 中文

### 搜索时保持虚拟链接的显示模式

修复了打开文档搜索时虚拟链接外观与平时不一致的问题：

- 搜索期间虚拟链接现在**复用平时的样式类**（`.virtual-link-span` 及类型/上下文类），完全跟随用户的显示模式：阴影模式仍是灰色底，纯颜色模式仍是彩色文字，替代样式同样生效；标题/笔记/fuzzy 的颜色区分和斜体、加粗、高亮等上下文样式也保持一致。
- 搜索命中的位置由 Obsidian 官方的 `.cm-searchMatch` 高亮自然覆盖（其优先级更高），不再需要特判。
- 移除了之前误加的「链接色 + 下划线」样式——那让虚拟链接看起来像真实链接。
- 因引用数量超限而隐藏链接的匹配，搜索时保持其平时的纯文本外观。

搜索关闭或清空后，虚拟链接恢复可点击交互。

---

## English

### Keep the display mode during document search

Fixed virtual links looking different from normal while the document search panel is open:

- While searching, virtual links now **reuse the same style classes** (`.virtual-link-span` plus type/context classes) as the widget, so the user's chosen display mode is fully respected: shadow mode keeps its grey chip, color-only mode keeps its colored text, and the alternative style works too. Header/note/fuzzy colouring and bold/italic/highlight contexts stay identical.
- Search hits are covered by Obsidian's official `.cm-searchMatch` highlight, which simply wins by specificity - no special-casing needed.
- Removed the earlier "link colour + underline" styling that made virtual links look like real links.
- Matches hidden by the reference limit keep their usual plain-text look while searching.

Virtual links return to their clickable interaction as soon as the search closes or empties.
