# 1.23.51

## 中文

**修复：跳转/预览到标题时，视图最后跑到错误的位置**

本版集中修复了"点击虚拟链接跳到标题后，画面先居中、最后却跑到另一个标题附近"的问题，涉及三条路径：

- **阅读模式**：点击链接时，插件内部有两条对齐逻辑同时启动、互相拉扯。其中一条并不知道目标是哪个标题，只能"猜"——于是把相邻的另一个标题移到了中间。现已让多余的那条让位，只保留知道确切标题的一条。
- **编辑模式（实时预览）**：当标题行带有装饰（例如此前加过 Heading Decorator 的图标）时，按文本查找目标标题会失败，旧逻辑会退化为"居中当前最靠顶的标题"——那正是目标的邻居。现在这种情况不再猜测，并新增**按行号精确定位**：行号取自 Obsidian 的元数据缓存，与行上渲染了什么装饰完全无关，且会用该行的源码文本做二次校验，确保定位到的一定是目标标题。
- **悬停预览**：同样接入了上述加固，并确保预览的对齐只作用于预览窗口自身，绝不会滚动主窗口。

修复后的行为：跳转与预览都会落在**正确的标题**上并保持稳定；万一目标行暂时不在渲染范围内，则宁可不动作（保持 Obsidian 自己选定的位置），也不会再跳到别的标题。

## English

**Fixed: view ending up at the wrong heading after a jump or preview**

This release fixes the "it centres first, then ends up next to a different heading" behaviour on all three paths:

- **Reading view**: two alignment routines used to run for the same click and fight each other. One of them had no idea which heading was linked and fell back to a guess, so it centred a *neighbouring* heading instead. The redundant one now stands down; only the routine that knows the exact heading remains.
- **Editing view (Live Preview)**: once a heading row carries decorations (such as Heading Decorator icons), looking the target up by its text fails, and the old code degraded to "centre whichever heading is nearest the top" - i.e. a neighbour of the target. It no longer guesses, and the lookup now resolves the heading through its **line number** from Obsidian's metadata cache, which is unaffected by whatever is rendered on that row. The line's source text is cross-checked as well, so only the actual target can ever be centred.
- **Hover preview**: the same hardening, and the preview now only ever scrolls its own pane - never the main window.

After this update, jumps and previews land on the **correct heading** and stay there. If the target row is not rendered at the moment, the plugin deliberately does nothing (leaving Obsidian's own position) rather than moving to a different heading.
