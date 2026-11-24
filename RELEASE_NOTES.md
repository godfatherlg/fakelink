# 1.24.31

## 中文

按 1.24.30 的反馈调整了两个开关的职责，并修复「只链一次」在几个场景下的问题。

- **两个开关解耦**：「排除指向自身的链接」现在只排除本篇笔记的**笔记名与别名**；指向本篇**标题**的链接由「允许链接到当前笔记的标题」单独控制。两者不再互相覆盖，「允许链接到当前笔记的标题」也不会因为老开关开着而变灰。
- **取消自动联动**：开启「允许在标题中显示虚拟链接」不再自动打开「排除指向自身的链接」（此前会自动打开且关闭时不还原，导致开关看起来"卡在灰态"）。
- **「只链一次」按目标计**：目标从「笔记」细化为「笔记 + 标题」。把词汇表写成标题、放在同一篇笔记里时，每个词条各链一次，而不是整篇只链一个。
- **修复：阅读视图 + 「只链一次」会清空全部链接**。此前的「已链接」记账跨渲染残留，重渲染后把整篇笔记判成已链接，一个链接都不生成（1.24.30 即存在）。
- **修复：标题行的匹配抢占「只链一次」目标**，导致正文里本该出现的链接被删掉、整篇为空。
- **说明补充**：「修复输入法问题」现在写明——中文/日文/韩文不以空格分词、没有词边界，所以「匹配单词的任意部分 / 开头 / 结尾」对它们不适用，而这几个语言真正需要的是这个开关，应保持开启。

## English

Reworks the two self-link options based on the 1.24.30 feedback and fixes "Only link once" in several cases.

- **The two options are decoupled**: "Exclude self-links to the current note" now only excludes the note's own **name and aliases**; links to its **headings** are controlled by "Allow links to headers in the current note" alone. Neither overrides the other any more, and the newer option is no longer greyed out just because the older one is on.
- **No more hidden coupling**: enabling "Allow virtual links in headers" no longer turns "Exclude self-links" on by itself (it used to, and turning it off again never reverted it, which made the other option look stuck in a disabled state).
- **"Only link once" counts targets**: the target is now "note + heading" instead of "note". A glossary written as headings inside one note keeps one link per entry instead of a single link for the whole note.
- **Fix: reading view + "Only link once" removed every link.** The "already linked" bookkeeping outlived a re-render, so the rebuilt note was treated as fully linked and produced no links at all (present in 1.24.30).
- **Fix: a heading-line match claimed the "Only link once" target**, which deleted the body link that should have been shown and left the note empty.
- **Docs**: the "Fix ime typing issues" description now states that Chinese/Japanese/Korean are written without spaces and have no word boundaries, so the "match any part of a word / beginning / end" options do not apply to them - this option is the one that matters there and should stay on.
