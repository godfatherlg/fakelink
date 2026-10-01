# 1.24.7

## 中文

**修复与优化**

- **修复**：分屏视图下未激活的窗格现在按**自身的笔记**渲染；文件夹排除、按笔记关键词排除（frontmatter 启用标记与排除列表）以及自链接规则不再读取编辑器激活的笔记
- **修复**：区分大小写的关键词不再产生模糊或词干链接——此前这两条路径会绕过大小写规则
- **修复**：被删除或重命名的笔记不再残留在模糊索引中；视图关闭时各视图的监听已正确释放；在未激活窗格中固化链接现在编辑的是该窗格
- **优化**：按笔记排除列表与文件元数据已缓存；保存笔记不再重建整个库索引；模糊匹配即时遵循词边界设置与模糊最小长度，无需重载

## English

**Fixes & performance**

- **Fix**: in a split view the non-focused pane now renders against its **own note**; folder exclusions, per-note keyword exclusions (the frontmatter opt-in property and the frontmatter exclude list) and the self-link rule no longer read the focused note
- **Fix**: case-sensitive keywords no longer receive fuzzy or stemmed links, which used to bypass the case rule
- **Fix**: notes deleted or renamed no longer linger in the fuzzy index; per-view listeners are released on close; converting a link in an unfocused pane edits that pane
- **Faster**: per-note exclusion lists and file metadata are cached, saving a note no longer rebuilds the whole vault index, and fuzzy matching now respects the word-boundary settings and the fuzzy minimum length without a reload
