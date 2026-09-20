# 1.23.35

## 中文

- **修复：靠"归一化"才能相等的匹配，不再显示成精准匹配，改为显示模糊匹配的颜色。**
  - 背景：词义模糊匹配会先把关键词归一化再比对 —— 中文会去掉「的 / 了 / 在 / 不 …」这类虚词（`不均衡性` → `均衡性`），英文会做词干还原；标题开头的编号（`5.不均衡性` 里的 `5.`）同样会被忽略。
  - 问题：归一化后的关键词以前被**当作正式关键词放进了"精准匹配"索引**，所以打 `均衡性` 命中的是"精准匹配"、显示精准色 —— 明明不是原文，看起来却像逐字命中。
  - 现在：这类命中一律按**模糊匹配**归类，显示模糊匹配的颜色。
  - **匹配结果完全没变**：还是同样的链接、同样的目标、同样的位置，只有颜色 / 归类不同。
  - 编辑器与阅读模式都覆盖。
- **标题符号白名单（`Heading symbol whitelist`）不算归一化**：它列的是你**主动要求忽略**的装饰符号（例如 🔥 这类标记），所以标题里带不带这个符号，都算**精准匹配**。
- 只有这两种情况算模糊：**去掉标题编号**、**去掉虚词 / 词干还原**。

## English

- **Fix: matches that only line up after normalisation now show the fuzzy colour instead of the exact-match colour.**
  - Background: fuzzy (词义模糊) matching normalises keywords before comparing them - Chinese function words are stripped (`不均衡性` → `均衡性`) and English words are stemmed; a heading's leading number (the `5.` in `5.不均衡性`) is ignored as well.
  - The problem: those normalised keywords used to be **inserted into the exact-match index as ordinary keywords**, so typing `均衡性` produced what looked like a verbatim exact hit and got the exact-match colour.
  - Now such hits are classified as **fuzzy** and tinted with the fuzzy colour.
  - **What matches does not change at all** - same links, same targets, same positions; only the classification / colour differs.
  - Applies to the editor and to the reading view.
- **The heading symbol whitelist is not treated as normalisation**: it lists decorations you explicitly asked the plugin to ignore (e.g. a 🔥 style marking), so a heading matches exactly whether or not the symbol is written.
- Only two cases count as fuzzy: **a stripped heading number**, and **stripped function words / stemming**.
