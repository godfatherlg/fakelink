# 1.24.21

## 中文

修复更新后的两个问题。

- **「What's new」弹窗恢复**：弹窗依赖的 `WHATS_NEW_VERSION` 常量从 1.24.15 起未再同步，导致 1.24.16–1.24.20 更新后都不弹窗。已与发布版本同步，并更新为本次改动的说明（中英双语）。
- **多窗口颜色修复**：卸载插件时会从所有窗口清除颜色变量，但此前只给当前活动窗口重新设置，导致弹出窗口（popout）更新后虚拟链接回退到默认颜色、需要再次 reload 才恢复。现在颜色变量（笔记 / 标题 / 模糊匹配）应用到所有窗口。

## English

Fixes two issues that showed up after an update.

- **The What's new dialog is back**: its `WHATS_NEW_VERSION` constant had not been bumped since 1.24.15, so the dialog was silently skipped for every update from 1.24.16 to 1.24.20. It is now kept in sync with the release and carries the notes for this change (English + Chinese).
- **Colour fix for multiple windows**: unloading the plugin strips the colour variables from every window, but they were only re-applied to the active window - a popout fell back to the default link colours after an update until the plugin was reloaded again. The colour variables (note / header / fuzzy) are now applied to every window.
