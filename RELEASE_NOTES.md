# 1.24.6

## 中文

**修复**

- **修复**：按笔记排除关键词（frontmatter 启用标记 `fakelink-exclude`、frontmatter 排除列表 `fakelink-exclude-keywords`）现在读取**正在渲染的笔记**，而非编辑器激活的笔记。预览笔记 B 而激活笔记 A 时，此前会误用 A 的 frontmatter，导致 B 声明要排除的词仍被链接（或反过来误排除）。精确与模糊两条匹配路径均已修正
- **清理**：移除 1.24.2 英文化遗留的两处「词义模糊」中文注释

## English

**Fix**

- **Fix**: per-note keyword exclusions (the frontmatter opt-in property `fakelink-exclude` and the frontmatter exclude list `fakelink-exclude-keywords`) now read the note being **rendered** instead of the focused one. Previewing B while A was active previously consulted A's frontmatter, so words B opted out of still got linked (and vice versa). Fixed on both the exact and the fuzzy matching paths
- **Cleanup**: removed two leftover Chinese glosses ("词义模糊") from 1.24.2's English pass




