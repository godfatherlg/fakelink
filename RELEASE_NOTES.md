# 1.24.13

## 中文

**默认设置调整（修复删除线变下划线）**

- **修复**：新安装时「替代显示样式」不再默认开启，删除线（`~~...~~`）恢复为标准显示（此前新用户装上插件后删除线会变成下划线，issue #22）
- **调整**：「显示高级设置」现在默认关闭，设置面板默认只显示核心选项，界面更简洁；打开它才会显示高级选项
- **调整**：以下功能改为默认关闭（打开「显示高级设置」后可开启）：「启用标题符号关键词」「当前行不显示链接」「行跳转（点击 adv-uri 跳转 / 在新标签页打开）」

## English

**Default settings reworked (fixes strikethrough → underline)**

- **Fix**: "Alternative display style" is no longer on by default, so strikethrough (`~~...~~`) renders normally for new installs (previously it became underlined, issue #22)
- **Change**: "Show advanced settings" is now off by default — the settings tab shows only the core options, and toggling it reveals the advanced ones
- **Change**: these now default to off (enable after turning on "Show advanced settings"): "Enable header symbol keywords", "Avoid linking in current line", and line jumping ("Jump to line on adv-uri click" / "Open in new tab")
