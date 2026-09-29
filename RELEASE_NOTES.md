# 1.23.52

## 中文

**新增：编辑中的表格单元格不显示虚拟链接**

表格单元格进入编辑时，正在编辑的那一格不再渲染虚拟链接 —— 文字保持纯文本，光标可以正常定位、可以自由输入，退出编辑后链接自动恢复。这样在表格里输入时不会被链接打断，也不会因为点到链接而误跳转。

开关位置：设置 → Exclusions →「编辑中的单元格不显示链接」，默认开启。

**已知限制**：暂时做不到"同行 / 同列 / 整张表格一起取消链接"。Obsidian 的表格（以及 Canvas）是多模式渲染，走的不是普通文本渲染的逻辑，插件这一侧的开关清不掉表格里那份渲染 —— 本插件"关闭虚拟链接"的设置对表格无效，也是同一个原因。如果需要彻底关掉表格里的虚拟链接渲染，目前只能借助 QuickAdd 之类的第三方脚本。

## English

**New: no virtual links in the table cell being edited**

When a table cell is opened for editing, that cell renders no virtual links: the text stays plain, the caret can be placed anywhere and typing works normally, and the links come back when you leave the cell. Editing inside a table is no longer interrupted — or mis-navigated — by a link sitting under the pointer.

Setting: Exclusions -> "No links in the cell being edited". On by default.

**Known limitation**: hiding the links of the whole row / column / table is not possible yet. Tables (and Canvas) are rendered by Obsidian through multiple modes rather than as plain text, so a plugin cannot remove that layer of rendering — the same reason this plugin's own "disable virtual links" setting does not clear the links inside a table. Turning virtual links off inside tables currently needs a third-party approach, such as a QuickAdd script.
