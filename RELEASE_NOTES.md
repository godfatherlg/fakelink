# 1.23.39

## 中文

**标题跳转与预览居中**
- 重写居中定位：改用元素自身的 DOM 实测坐标，修复一级标题、媒体笔记（多行属性）、属性折叠等场景下跳转/预览后标题不居中的问题。
- 预览弹窗改用 hover 时记录的标题 id 精确定位，不再按「视口顶部」猜——修复弹窗居中到目标上方小标题（如「5五,治疗操作」）的问题。
- 支持带章节号的标题匹配（链接里的「（六）牙痛」能对上渲染出的「牙痛」）。
- Obsidian 核心预览（纯 HTML 弹窗）现在也参与居中。
- 修复预览弹窗里标题反复滚动的问题（同一编辑器只保留一个居中循环）。
- 居中拉正速度从约 6 秒缩短到约 1.5 秒。

**右键菜单**
- 修复：点进表格单元格后，「转真实链接」总指向第一个文件；现在按右键命中的编号转对应文件。
- 修复：多引用编号列表 `[1|2|3]` 在菜单关闭后一直不收起（补齐锁定清理）。
- 菜单打开期间列表保持展开，菜单关闭才收起（去掉固定 10 秒的强制收起）。

**转真实链接**
- 修复：多个表格含同名文本时（如两个表格都有「莱布尼茨判别法」），转换会定位到第一个表格；改用表头签名 + 逐块校验定位。

## English

**Heading jump / preview centring**
- Rewrote the centring logic to measure the element itself (DOM rect) - fixes headings not being centred after a jump or in a preview for h1 titles, media-heavy notes (multi-line properties) and collapsed properties.
- A preview popover now locates its target by the heading id recorded on hover instead of guessing "the heading at the top" - fixes the popover centring a neighbouring sub-heading above the target.
- Heading matching now tolerates a chapter-number prefix ("（六）牙痛" in the link vs. "牙痛" as rendered).
- Obsidian's core Page Preview (plain-HTML popover) is now aligned too.
- Fixed repeated scrolling inside a preview (only one centring loop per editor now).
- Centring now lands in about 1.5s instead of about 6s.

**Context menu**
- Fixed: inside a table cell, "Convert to real link" always targeted the first file; it now targets the file of the clicked number.
- Fixed: the `[1|2|3]` list stayed open after the menu closed (lock cleanup).
- The list now stays open while the menu is open and collapses when it closes (no more fixed 10s timeout).

**Convert to real link**
- Fixed: with identical text in several tables, conversion landed in the first table; positioning now uses a header signature plus per-block verification.
