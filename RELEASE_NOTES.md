# 1.24.2

## 中文

**修复 + 全量代码英文化**

- **修复**：正文里的词与**带编号的标题**匹配时（如正文写「核心公式」、标题是「1. 核心公式」），不再被错误地显示为模糊匹配的颜色 —— 编号只是标题的排版前缀，这样的匹配就是精确匹配，现在显示精确色。只要笔记库里有任何一个带编号标题，其剥离编号后的词就会被全局标为模糊色，连带影响所有该词的精确匹配；这一误标已移除
- **i18n 补全**：批量转换对话框（单篇 / 多篇）里的所有提示文案原先硬编码为中文，现在全部接入 `t()` 翻译体系，跟随应用语言显示
- **代码英文化**：全部源码注释由中文译为英文（约 130 处），并清掉了注释里冗余的中文词（如「词义模糊」——旁边本就有英文）；`src/contextMenu.ts` 的缩进从类方法风格修正为模块函数风格
- 保留的中文：`helpers.ts` 翻译表（译文值）、中文停用词列表（算法数据）、演示中文匹配场景的示例词

## English

**Fix + full code de-sinicization**

- **Fix**: a word in the body that matches a **numbered heading** (body says "核心公式", heading is "1. 核心公式") no longer shows the fuzzy-match colour — the number is just the heading's layout prefix, so this is an exact match and now paints as one. As soon as any numbered heading existed in the vault, its number-stripped keyword was globally flagged as derived, which recoloured every exact match of that word; that flagging is removed
- **i18n completed**: every message in the batch-convert dialogs (single / multiple notes) was hardcoded Chinese; they now go through `t()` and follow the app language
- **Code de-sinicized**: all source comments were translated from Chinese to English (~130 spots) and redundant Chinese words inside comments were dropped (e.g.「词义模糊」next to the English "fuzzy"); `src/contextMenu.ts` indentation corrected from class-method style to module-function style
- Chinese kept on purpose: the `helpers.ts` translation table (translated values), the Chinese stop-word list (algorithm data), and example words demonstrating Chinese matching scenarios
