# 1.23.34

## 中文

- **修复：插件刚加载（或重载）后，`==高亮==` 里的虚拟链接会丢掉高亮底色，点一下才恢复正常。** 原因：一个链接是否处于「高亮 / 加粗 / 斜体 / 删除线 / 注释 / 标题」之中，是**从 Markdown 语法树读出来的**，而语法树是**异步解析**的 —— 插件加载的那一刻树还是空的，于是第一批链接没被标上对应的格式类，只有你点一下（光标移动）才触发重建补上。现在只要语法树发生变化（也就是解析完成）插件就会自己重建一次，**不需要再点**。同一处修复也覆盖了另外几种格式（加粗 / 斜体 / 删除线 / 注释 / 标题）在加载瞬间的同类漏标。
- **修复（社区插件审核）：样式表里删掉了全部 11 处 `!important` 和那 1 处 `:has` 选择器。** 整体底色改为依靠 CSS 变量 + 更高的选择器特异性生效；「缩进行的上一行」从 CSS 的兄弟选择器挪进了编辑器的装饰器（由插件打类名）。这两条正是审核会报的告警，本版按建议改掉。**副作用提示**：如果某个主题把自己的背景或表格样式写死并带 `!important`，那一项可能会被主题盖过去（默认主题与大多数主题不受影响）。
- **变更（仅影响「背景」设置）：判定为「缩进行」的条件放宽为 —— 行首是 Tab，或者 2 个以上空格。** 以前只认列表续行 / 嵌套项（靠 Obsidian 的内部类名），所以纯空格缩进的段落和它上面那一行不会着色；现在都能识别，并且不再依赖那些内部类名。

## English

- **Fix: right after the plugin loaded (or was reloaded), a virtual link inside `==highlight==` lost its highlight background until you clicked somewhere.** Whether a link sits inside highlight / bold / italic / strikethrough / comment / heading is read from the Markdown syntax tree, which parses **asynchronously** - the first batch of decorations was built while that tree was still empty, so those links were drawn without the matching format class, and only a click (a cursor move) forced a rebuild. The linker now rebuilds by itself whenever the syntax tree changes, so **no click is needed**. The same fix covers the other formats (bold / italic / strikethrough / comment / heading) at load time.
- **Fix (community plugin review): all 11 `!important` declarations and the single `:has` selector were removed from the stylesheet.** The background tint is now applied through CSS variables and higher selector specificity, and "the line above an indented line" moved out of a CSS sibling selector into the plugin's editor decoration. **Note**: if a theme hard-codes its own background or table styles with `!important`, that particular part may now be overridden by the theme (default and most themes are unaffected).
- **Changed (Background setting only): a line counts as "indented" when it starts with a Tab, or with two or more spaces.** Previously only list continuation / nested lines were recognised (through Obsidian's internal class names), so space-indented paragraphs and the line above them were not tinted; now they are, without relying on those internal classes.
