# 1.23.26

## 中文

- **移除：「按 Ctrl/Cmd+点击才打开虚拟链接」设置**。这个开关已删掉（界面、代码、翻译一起清掉），**单击虚拟链接即跳转**，不会再检查任何修饰键。想在链接所在行放光标依旧由「当前行不显示链接」负责。
- **内部整理（来自社区插件审核反馈）**：内联样式改写为 `setCssStyles`、修正类型并去掉多余断言、删除不再使用的变量与导入、字符类正则改为范围写法。
- 除上述移除的开关外，**行为没有变化** —— 跳转、悬停预览、尺寸预留、标题对齐都与 1.23.25 一致。

## English

- **Removed: the "Require Ctrl/Cmd+click to open virtual links" setting.** The toggle is gone (UI, code and translations), and a plain click on a virtual link opens it again - no modifier is checked any more. Placing the caret in a link's line is still handled by "Avoid linking in current line".
- **Internal cleanup from the community-plugin review**: inline styles now go through `setCssStyles`, tightened types and dropped redundant assertions, removed unused variables/imports, and a character class rewritten as a range.
- **No behaviour changes** beyond the removed toggle - jumps, hover previews, size reservation and heading alignment are identical to 1.23.25.
