# 1.23.41

## 中文

**多指向虚拟链接（`[1|2|3]`）排序重做，越相关越靠前**

- 排序分四层：
  1. **正文里已经提到过它** —— 前面已有一条指向它的链接（精准**或模糊**匹配都算），或它的文件名 / 别名在文中出现过 —— **直接排到最前**，压过下面的档位；
  2. **档位**：文件名精准 > 文件名包含 > 别名 > 标题原文等于关键词 > 标题去掉章节号后相等 > 标题仅包含；
  3. **上下文距离**：同一档位内，正文里提到它的位置离关键词越近越靠前（判断范围从"当前段落"扩大到**整篇**）；
  4. **时间兜底**：最后修改时间越新越靠前（新建笔记的 mtime 就是 ctime）。
- 修复：标题**原文**等于关键词的笔记，可能排在"标题只是包含关键词"的笔记后面。
- 修复：文件名**正好等于关键词**、但同时带标题匹配的笔记，被当成标题匹配排到了最后。
- 修复：同一组候选在渲染前互相把对方记成"已链接"，导致相关性加权失效（快照顺序）。
- 说明：重命名不会更新文件的 ctime / mtime，因此"改过文件名"无法被判定为"更新"。

## English

**Multi-target link ranking (`[1|2|3]`) reworked — most relevant first**

- Four ranking layers:
  1. **Already mentioned earlier in the note** — an existing link to it (exact **or fuzzy**) or its file name / alias appearing in the text — ranked **first, above the tiers below**;
  2. **Tier**: exact file name > partial file name > alias > heading equals the keyword > heading equals it after stripping the section number > heading merely contains it;
  3. **Context distance**: within a tier, the closer the mention sits to the keyword, the earlier (scope widened from the current paragraph to **the whole note**);
  4. **Recency fallback**: most recently modified first (a new note's mtime equals its ctime).
- Fixed: a note whose heading **is** the keyword could rank after one whose heading merely contains it.
- Fixed: a note whose file name **equals** the keyword, but which also has a heading match, was ranked as a heading match and pushed last.
- Fixed: candidates marking each other as "already linked" before rendering, which disabled the relevance boost (snapshot order).
- Note: renaming does not update ctime / mtime, so a renamed note cannot be treated as "newer".
