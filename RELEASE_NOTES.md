# 1.23.55

## 中文

**修复：启动后第一次悬浮预览不会居中**

插件的索引是分块异步构建的，大库在启动后一小段时间内索引还是空的。这时弹出的悬浮预览里内容尚未渲染，对齐逻辑找不到目标标题，于是静默放弃 —— 表现为"第一次预览没居中，换一个链接或等一会儿就好了"。现在对齐会先等索引构建完成再开始。

**新增：新建 / 删除 / 重命名笔记后立即刷新索引**

以前新建一篇笔记后，它要等"切换文件"或"重启插件"才会进入索引 —— 也就是说，新建的术语笔记在原文里不会立刻被链上。现在这三个操作会立刻触发索引刷新（约 1 秒后生效）。

为了不影响性能，这里做了三点约束：

- **不监听"保存"事件** —— 编辑时每隔几秒就保存一次，绑上去会导致频繁重建索引，大库会卡
- **只认 Markdown 文件** —— 拖入图片、附件或新建文件夹不会触发重建
- **800 毫秒防抖** —— 连续多个操作（比如一次拖入一批文件）合并成一次刷新

## English

**Fixed: the first hover preview after startup was left uncentred**

The index is built asynchronously in chunks, so for a short while after startup it is still empty. A hover preview opened during that window had no rendered content to align to, and the alignment silently gave up — which read as "the first preview is not centred, later ones are". It now waits for the index to finish building before it starts.

**New: the index refreshes right after a note is created, deleted or renamed**

Previously a newly created note only entered the index once you switched notes or restarted — so a freshly created term was not linked in existing notes. These three operations now refresh the index immediately (visible after about a second).

Three deliberate limits keep this cheap:

- **The "modify" (save) event is NOT watched** — saving happens every few seconds while typing, and rebuilding on each one would stutter a large vault
- **Markdown files only** — dropping in images, attachments or a folder does not trigger a rebuild
- **800 ms debounce** — a burst of changes (e.g. a batch of dropped files) becomes a single refresh
