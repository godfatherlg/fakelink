# 1.23.42

## 中文

**新增：单篇笔记可关闭自身内部的虚拟链接（源侧禁用）**

- 新设置「单篇禁用虚拟链接」，位于 **Files** 分组（在「排除生成虚拟链接的目录」正下方，两者都是源侧排除）。可选择一种方式：
  - **按标签**（默认）：笔记带 `linker-ignore` 标签即生效 —— 可写在 frontmatter（`tags: [linker-ignore]`）或正文任意处（`#linker-ignore`），也支持层级标签；
  - **按 Frontmatter 属性**：frontmatter 写 `linker-ignore: true` 即生效；
  - **关闭**：不启用该功能。
- 两种方式的名字都可在设置里自定义；因为同一时间只生效一种，默认值统一为 `linker-ignore`，与 `linker-exclude`、`linker-ignore-case`、`linker-match-case` 的前缀保持一致。
- 属性判定做了宽松处理：`true`、`"true"`（Obsidian 属性面板按「文本」类型存储时写成的字符串）、`True` 都算开启。
- 标签判定同时检查正文的 `#tag` 与 frontmatter 的 `tags`，避免不同 Obsidian 版本对二者归并方式不一致导致漏判。
- 说明：这与已有的 `linker-exclude` 方向相反 —— 后者是"让这篇笔记**不被别处链接到**"（目标侧），本次新增的是"这篇笔记**自己内部不生成任何虚拟链接**"（源侧）。

## English

**New: a single note can switch off virtual links inside itself (source-side opt-out)**

- New setting "Single-note opt-out", placed in the **Files** group right under "Excluded directories for generating virtual links" (both are source-side exclusions). Pick one method:
  - **By tag** (default): a note carrying the `linker-ignore` tag renders no virtual links — put it in the frontmatter (`tags: [linker-ignore]`) or anywhere in the body (`#linker-ignore`); nested tags are supported;
  - **By frontmatter property**: `linker-ignore: true` in the frontmatter;
  - **Off**: the feature is disabled.
- Both names are configurable; since only one method is active at a time, both default to `linker-ignore`, matching the existing `linker-` prefix family (`linker-exclude`, `linker-ignore-case`, `linker-match-case`).
- The property check is lenient: `true`, `"true"` (what Obsidian's Properties panel writes for a text-typed property) and `True` all count as enabled.
- The tag check looks at both in-body `#tags` and frontmatter `tags`, since Obsidian versions differ in whether they merge the latter into the tag cache.
- Note this is the opposite of `linker-exclude`, which stops a note from being linked **from elsewhere** (target-side); this one stops the note from generating any virtual links **inside itself** (source-side).
