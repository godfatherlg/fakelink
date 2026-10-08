# 1.24.10

## 中文

**英文匹配修复 + 重载渲染修复**

> 致歉：作者本人很少使用英文笔记，因此这个插件源自 virtual-linker 的英文单词匹配相关功能，长期以来一直没有经过充分验证。本次根据用户反馈（issue #20）修复了这些问题，对英文用户此前遇到的不便深表抱歉。

- **修复**：「匹配单词开头 / 结尾」开关此前对英文不生效（关闭后前缀 / 后缀仍会匹配）；现在「任意部分 / 开头 / 结尾」三个开关按预期工作
- **改进**：中文、日文假名、韩文谚文以及汉字扩展区等无空格文字始终按「子串」匹配，不再受英文词边界开关影响；设置说明已同步标注
- **修复**：插件重载后，已打开的实时预览（Live Preview）笔记无需点击即可显示链接
- **修复**：重载后链接「渲染出来又消失」的问题——索引重建的瞬间不再用空索引清空已有链接

## English

**English matching fixes + reload rendering fixes**

> Apology: I rarely write English notes myself, so the English word-matching features inherited from virtual-linker had gone largely untested for a long time. This release fixes those issues (reported in issue #20). My apologies to English users for the inconvenience.

- **Fix**: the "Match the beginning / end of words" toggles had no effect on English (prefixes / suffixes still matched after turning them off); the three toggles ("any part / beginning / end") now work as expected
- **Improve**: unspaced scripts — Chinese, Hiragana/Katakana, Hangul and Han extensions — always match as substrings and are no longer affected by the English word-boundary toggles; the setting description now says so
- **Fix**: after a plugin reload, open Live Preview notes show their links without needing a click
- **Fix**: links no longer "render then vanish" after a reload — the moment the index is being rebuilt no longer wipes existing links with an empty index
