# 1.24.33

## 中文

修 callout 里「只链一次」的四个问题，全部由"把 callout 文本映射回笔记位置"这一步不准引起。

- **短词不再每行都链**：查找时跳过了少于 4 个字的内容，日文里常见的三字关键词因此没做判断，callout 里每一行都链上了。现在不再有长度门槛。
- **行首空白不再丢链接**：定位用的是去掉空白后的文本，而匹配位置是按原始文本算的，两者相差前导空格的字符数，导致"第一次出现"被判成"之前已出现过"。现在按未去空白的节点计算。
- **重复行不再错位**：相同的行都从笔记开头查找，全部映射到第一处，渲染完成后链接可能跳到另一行。现在从上一处的位置继续往后找，每行对应自己的位置。
- **映射不到时不再"全部链接"**：以前找不到位置就跳过判断，等于 callout 里所有重复词都链；现在找不到只影响该处，不会连带整块。

实测（只链一次打开）：正文已出现过的三字关键词在 callout 里 0 个链接；行首全角空格的词正常链接；同一 callout 内重复行只链第一处；编辑态与渲染完成态链接位置一致；关闭开关后 callout 恢复全部链接。131KB 笔记滚动 p95 17ms。

## English

Fixes four "Only link once" problems inside callouts, all caused by the step that maps callout text back to a position in the note.

- **Short keywords are no longer linked on every line**: the lookup skipped anything shorter than four characters, so a three-character Japanese keyword was never checked and every callout line got a link. There is no length threshold any more.
- **A leading space no longer loses the link**: the lookup used trimmed text while the match offset was not trimmed, shifting the position by the number of leading spaces and making the first occurrence look like an earlier one. Offsets are now computed from the untrimmed node.
- **Identical lines no longer collapse onto the first one**: every identical line was searched from the start of the note, so all of them pointed at the first occurrence and the link could jump to another line after rendering. The search now continues from the previous match, so each line maps to its own position.
- **A failed lookup no longer links everything**: previously an unmapped block skipped the check entirely, which linked every duplicate inside the callout; now only that occurrence is affected.

Verified with "Only link once" on: a three-character keyword already linked in the body produces 0 callout links; a line starting with an ideographic space links normally; repeated lines inside one callout link only the first; the edit and finished states agree; with the option off the callout links everything again. Scrolling a 131 KB note: p95 17 ms.
