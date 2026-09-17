# 1.23.22

## 中文

- **修复：高亮内的虚拟链接不再加深背景**。此前虚拟链接会在原生高亮之上自己再刷一层底色，两层半透明色叠加，让被 `==高亮==` 包住的链接看起来比周围文字更浓、更深。现在链接不再绘制自己的背景，完全由原生高亮透出——**背景与周围完全一致，只有字体颜色不同**。
- 编辑模式与阅读模式使用同一条规则，行为统一。

## English

- **Fix: links inside a highlight no longer look darker**. A virtual link used to paint a background of its own on top of the native highlight; the two translucent layers stacked, making the link look darker than the text around it. The link now paints nothing and lets the native highlight show through, so the background matches the surrounding text exactly — only the text colour differs.
- The same rule now applies to both live preview and reading view.
