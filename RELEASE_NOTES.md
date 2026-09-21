# 1.23.37

## 中文

**性能修复（超大库）**
- 首次建索引与增量重建改为分片执行：每索引 256 个文件就让出一次主线程，避免在超大库里启用插件时界面卡死 / 黑屏。

**新增（设置 → 外观 → 背景，打开「背景」后可见）**
- 「背景着色强度」滑块：调整列表 / 缩进 / 表格 / 调用块那一层淡蓝底色的透明度（范围 0–60，默认 10）。
- 「光标行强度」滑块：调整光标所在行暖橙色高亮的透明度（范围 0–100，默认 35）。

**移除**
- 设置页里的两个「复制」按钮：「Copy Quick Add script」与「Copy EasyTyping template」，连同相关模板与翻译一并移除。

## English

**Performance fix (very large vaults)**
- The initial index build (and incremental rebuilds) now yield to the UI every 256 files, so enabling the plugin in a very large vault no longer freezes the app.

**New (Settings → Appearance → Background, shown once "Background" is on)**
- "Background tint strength" slider: controls the opacity of the light blue tint on list / indented / table / callout lines (0–60, default 10).
- "Cursor line strength" slider: controls the opacity of the warm orange highlight on the line the cursor is on (0–100, default 35).

**Removed**
- The two "Copy" buttons in the settings ("Copy Quick Add script" and "Copy EasyTyping template"), along with their templates and translations.
