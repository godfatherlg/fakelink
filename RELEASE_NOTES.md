# 1.24.12

## 中文

**标签页激活标识优化**

- **改进**：激活标签页现在用「顶部 + 底部」两条强调色条标记，比原来只有底部一条更醒目，一眼就能定位当前页
- **改进**：未激活的标签不再被淡化（不透明度恢复为 1）——之前压到 0.72 会让标签文字看不清；现在区分完全靠给激活页加标识，而不是把其他标签调淡，标签栏所有文字都保持清晰

## English

**Active-tab marker reworked**

- **Improve**: the active tab is now marked by two accent bars (top and bottom) instead of a single bottom one, so it is much easier to spot at a glance
- **Improve**: inactive tabs are no longer dimmed (opacity back to 1) — the previous 0.72 dim made their labels hard to read. The active tab now stands out purely by its own markers, not by fading the others, so every label in the tab bar stays legible
