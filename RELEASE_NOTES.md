# 1.24.9

## 中文

**冷启动与弹出窗口修复**

- **修复**：冷启动时索引构建早于仓库文件列表，索引可能被判为"就绪"却一个文件都没索引，导致链接永久缺失；现在空构建不再标记就绪，并在布局就绪后自动全量重建
- **修复**：启动或插件重载时，已打开的笔记不再需要点击才会显示链接——索引就绪后会主动刷新所有窗口（含弹出窗口）中打开的笔记
- **修复**：备用显示样式 / 仅颜色显示的样式类现在应用到所有窗口，弹出窗口不再回退到阴影样式
- **修复**：悬停预览读取的 data-href 现在包含 `#标题` 锚点，预览弹窗会滚动到并高亮对应标题，而不是停在笔记顶部

## English

**Cold-start & popout fixes**

- **Fix**: on a cold start the index build could run before the vault listed its files and be marked ready with zero files indexed, leaving links missing forever; an empty build no longer marks the index ready, and a full rebuild now runs automatically once the layout is ready
- **Fix**: notes that are already open at startup or after a plugin reload no longer need a click before links appear - every open note in every window (popouts included) is refreshed once the index is ready
- **Fix**: the alternative / color-only display style classes are now applied to every window, so popouts no longer fall back to the shadow look
- **Fix**: the data-href read by the hover preview now includes the `#heading` anchor, so the popover scrolls to and highlights the heading instead of opening at the top of the note
