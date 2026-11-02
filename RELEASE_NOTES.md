# 1.24.18

## 中文

搜索时虚拟链接不再失去功能，与原生实时预览的搜索表现一致。

- **链接保持可交互**：搜索面板打开并输入关键词时，虚拟链接仍然是正常的链接——点击跳转、hover 预览、加粗/斜体/高亮等格式渲染全部照常工作，不再退化成不可点击的纯文本。
- **命中高亮画在链接内部**：官方搜索高亮作用在文本节点上，无法进入虚拟链接的 widget，所以由插件在 widget 内部绘制。当前匹配复用官方的 `obsidian-search-match-highlight` 样式（accent 方框，与阅读模式一致），其余命中用淡框提示。
- **只标记当前匹配**：读取 Obsidian 自身的搜索高亮装饰来确定「当前匹配」，按 Enter / 上一个 / 下一个切换匹配时，链接内的高亮同步跟随。
- **隐藏行内包裹标记**：搜索会选中当前匹配、把光标带进 `**...**` 里，导致 `**`、`==`、`~~`、`` ` `` 等标记展开显示。搜索激活期间自动隐藏这些行内标记（标题 `#`、列表 `-` 等结构标记保持不变）。

## English

Virtual links no longer lose their behaviour while the document search is open; they now match the native Live Preview search experience.

- **Links stay interactive**: with the search panel open and a query typed, a virtual link is still a real link - click, hover preview and bold/italic/highlight formatting all keep working instead of degrading to plain non-clickable text.
- **The hit highlight is painted inside the widget**: Obsidian's own search highlight works on text nodes and cannot reach a replace widget, so the plugin paints it inside the widget instead. The current match reuses Obsidian's `obsidian-search-match-highlight` style (the accent box, identical to Reading view); other hits get a faint outline hint.
- **Only the current match is marked**: the plugin reads Obsidian's own search-highlight decoration to find the current match, and the in-link highlight follows it when you press Enter / use the previous / next buttons.
- **Inline wrapping markers stay hidden**: searching selects the current match and moves the caret inside `**...**`, which made Live Preview reveal `**`, `==`, `~~` and `` ` `` markers. They are hidden again while a query is active (structural markers such as heading `#` and list `-` are untouched).
