# 1.23.36

## 中文

- **修复：悬停虚拟链接时，预览弹窗过一会儿会自己关闭，有时还伴随页面向上滚动一下。** 根因：预览弹窗一出现，插件就启动一个约 12 秒的「标题对齐观察器」，不断向弹窗内写滚动位置 —— 对 Obsidian 自带的核心「页面预览」弹窗来说，这个持续滚动会把它顶关，并带出页面一跳。现在这个对齐观察器**只对 Hover Editor（含真实编辑器的弹窗）生效**；核心预览弹窗交给 Obsidian 自己定位，不再被插件干扰。
- **改进：多目标虚拟链接**（悬停出现 `1|2|3` 的那种）加了约 0.4 秒的收起宽限，把鼠标从链接文字移到编号上时不再容易「丢失」。
- **说明**：作者此前一直与 Hover Editor 插件配合使用 —— Hover Editor 是「钉住」的独立窗口、不会自己关闭，因此这个 bug 一直没有被发现。感谢反馈。

## English

- **Fix: a hovered virtual link's preview popover used to close on its own after a moment, sometimes with the page scrolling up once.** Root cause: as soon as the popover opened, the plugin started a ~12-second "heading alignment watcher" that kept writing scroll positions into the popover. For Obsidian's own core Page Preview popover, that continuous scrolling is what closed it (and made the page jump). The watcher now runs **only for Hover Editor** (popovers that host a real editor); the core preview popover is left to Obsidian and is no longer disturbed.
- **Improved: multi-target virtual links** (the ones showing `1|2|3` on hover) got a ~0.4s grace before their targets collapse, so moving the pointer from the link text onto the numbers no longer drops them.
- **Note**: the author had always used the plugin together with Hover Editor, which is a pinned window that never closes on its own - that is why this bug went unnoticed. Thanks for the report.
