# 1.24.32

## 中文

「只链一次」原来按"当前这一屏算出来的内容"判断，因此会出现：同一篇笔记里隔几屏的两处都被链上、滚动时链接时有时无、callout 里重复全链、callout 之后正文又重新开始。这个版本改成**按整篇笔记判断**。

- **整篇只链一次**：开启后，只有"该关键词在全文中的第一次出现"会变成链接，其余一律不链。判断依据是笔记文本本身，不再是每次渲染的临时记录，所以滚动、切换视图、重新渲染都不会改变结果。
- **callout 与正文一致**：实时预览里的 callout 走的是阅读视图渲染路径，过去自己记一套账（callout 内重复全链、callout 之后正文重新算）。现在它和正文用同一条"全文第一次出现"规则。
- **标题行不再算作"第一次出现"**：标题行本身永远不会链回自己的笔记，过去它却会被当作已出现，导致正文里真正的第一次出现被吞掉、整篇没有链接。
- **性能**：全文判定只在打开该开关时计算，并按文档文本缓存，文本不变就不重算；131KB 笔记实测滚动 p95 17ms、无掉帧。
- 阅读视图保持整篇一次性渲染，行为不变。

## English

"Only link once" used to be decided from the content produced by the current render pass, which showed up as: two occurrences a few screens apart both linked, links appearing and disappearing while scrolling, every duplicate inside a callout linked, and the body starting over after a callout. It is now decided from the note as a whole.

- **One link per note**: with the option on, only the first occurrence of a keyword in the document becomes a link. The decision is based on the note text, not on a per-render ledger, so scrolling, switching views and re-rendering no longer change the result.
- **Callouts agree with the body**: a callout in Live Preview is rendered through the reading-view path and used to keep its own small ledger (duplicates inside it all linked, the body restarting afterwards). It now follows the same document-wide rule.
- **A heading line no longer counts as the "first occurrence"**: it never links to its own note, so counting it used to swallow the first real body link and leave the note unlinked.
- **Performance**: the document is analysed only while the option is on and cached per text version; measured 17 ms p95 and no dropped frames while scrolling a 131 KB note.
- The reading view still renders the whole note at once and keeps its existing behaviour.
