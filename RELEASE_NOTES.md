# 1.24.26

## 中文

性能修复：编辑与模式切换更快，并给出排除 Obsidian 更新问题的建议。

- **不再每次重建都遍历库**：文件夹范围检查在功能关闭时直接跳过（之前即使没开也会遍历一次库根目录）。
- **缓存真实链接目标**：笔记的真实链接引用只在笔记内容变化后重新解析，之前每次重建（光标移动 / 滚动 / 切换模式）都会重新读取并解析一遍。
- **建议**：如果更新 Obsidian 后感觉光标或输入延迟，建议用 **Obsidian 1.15.0 重新安装一次**，以排除 Obsidian 更新本身带来的问题。

## English

Performance fix: faster edits and mode switches, plus advice for ruling out problems from the Obsidian update.

- **No vault walk per rebuild**: the folder-range check is skipped entirely while the feature is off (it used to walk the vault root even then).
- **Cached link targets**: a note's real link references are only re-resolved after the note changes; every rebuild (cursor move / scroll / mode switch) used to read and resolve them again.
- **Advice**: if you noticed cursor or typing delays after updating Obsidian, reinstall **Obsidian 1.15.0** once - that rules out problems coming from the Obsidian update itself.
