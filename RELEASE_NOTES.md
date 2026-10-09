# 1.24.11

## 中文

**标签页强调样式修复**

- **修复**：激活标签页的字体颜色此前时有时无——颜色只设在了标签外层，靠子元素继承，而主题（或 Obsidian 自身）一旦给标题文字单独设了颜色就会覆盖继承；现在直接给标题元素上色，任何主题下都稳定生效
- **修复**：分栏（分屏）时每个窗格当前的标签都会被加上强调样式，看起来像同时有多个「激活页」；现在只有当前聚焦的那个窗格会有完整强调色，其余窗格保持普通外观
- **改进**：未激活的标签淡化得更明显（不透明度 0.9 → 0.72），激活页更容易一眼分辨

## English

**Active-tab styling fixes**

- **Fix**: the active tab's label colour only applied sometimes — it was set on the tab's outer element and inherited, so any theme (or Obsidian itself) that colours the label element directly overrode it. The label element is now coloured directly, so the accent holds under any theme
- **Fix**: in a split view every pane's current tab got the accent, so it looked like several "active" tabs at once. Only the FOCUSED pane's active tab is accented now; the other panes keep their normal look
- **Improve**: inactive tabs dim further (opacity 0.9 → 0.72), so the active one stands out at a glance
