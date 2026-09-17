# 1.23.23

## 中文

- **修复：`==…**加粗**…==` 里的虚拟链接丢失高亮底色**。加粗会把高亮的嵌套打断，链接虽然被标记为"在高亮内"，实际却不在原生高亮元素里；上一版把高亮场景统一改成透明后，这类位置就露出了白底。现在按两种 DOM 形状分开处理：**真的在原生高亮元素里的保持透明**（避免两层叠加变深），**嵌套被打断的自己补一层同色底**。
- 覆盖面：纯高亮 `==链接==`、高亮套加粗 `==**链接**==`、编辑模式与阅读模式，行为全部统一；链接只保留字体颜色差异。

## English

- **Fix: a link inside `==…**bold**…==` lost its highlight background.** The bold run breaks the highlight nesting, so the link is flagged as "inside a highlight" but does not actually sit inside the native highlight element; the previous version turned every highlighted link transparent, leaving those spots colourless. The two DOM shapes are now handled separately: links genuinely inside the native highlight stay **transparent** (no stacked translucent layers), while links whose nesting was broken **paint the highlight colour themselves**.
- Consistent across plain `==link==`, `==**link**==`, live preview and reading view — only the text colour differs from ordinary highlighted text.
