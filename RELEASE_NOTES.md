# 1.23.46

## 中文

**Live Preview 打字更流畅**

以前每按一次方向键、每移动一下光标，都会把可见区域的虚拟链接全部重算一遍 —— 长笔记上这是明显的掉帧来源。现在只有真正依赖光标位置的设置（「排除当前行的链接」、IME 相关）开启时，光标移动才会触发重建；否则只由文档变化、滚动、切换笔记触发。

**读模式下「只链接一次」真正生效**

读模式是把一篇笔记分成若干块分别渲染的，而每块都是独立实例，记录"已经链过哪些笔记"的集合每块都会清空。结果是「只链接一次」形同虚设：同一个目标在每个段落里都会被再链一次；前一块收集到的真实 `[[链接]]` 也会被后一块遗忘。

现在这些集合按笔记共享（250 毫秒窗口）：同一次渲染的连续几块共享，间隔较久的重渲染则重新开始 —— 否则残留的"已链接"记录会让新链接永远不再出现。

**词干还原修复：不再每跑一次就变短**

`caresses` 的正确词干是 `caress`。旧实现先拼好新结尾、随后又按旧下标截断一次，把刚拼上的 `ss` 砍掉一个，于是结果是 `cares`，再跑一次又变 `care` —— 每处理一次就更短一点。`press`、`access`、`process` 这类以 `s` 结尾的词同样受影响（例如 `press` 被削成 `pres`）。

现在按规则直接截断（`sses → ss`、`ies → i` 都是去掉末尾的 `es`），结果稳定不变。只影响开启了「词干还原匹配」且匹配到这类单词的用户，且是从错误结果改为正确结果。

**新增单元测试**

`npm test` 可运行，覆盖词干还原、`stripHeadingNumber`、`checkWordBoundary`。其中一条是防回归的：用章节号形状的对抗性输入断言耗时上限，防止把标题编号剥离改回那种会指数回溯、导致预览卡死的正则写法。

另：删除了一个定义了却从未被调用的方法（`isFormattingChar`），并与读模式里一条已经过时的 TODO 注释做了澄清。

## English

**Smoother typing in Live Preview**

Moving the caret used to rebuild every decoration in the visible range - a full rebuild per arrow key, and a real source of stutter on long notes. A caret move now triggers a rebuild only when a setting that depends on the caret position is on ("exclude links in the current line", or the IME workaround); otherwise rebuilds come from document changes, scrolling and switching notes.

**"Link only once" now works in reading mode**

Reading mode renders a note as several blocks, each processed by its own instance, so the "already linked" bookkeeping was emptied for every block. "Link only once" therefore linked the same target again in each paragraph, and real `[[links]]` collected in an earlier block were forgotten by later ones.

Those sets are now shared per note within a 250 ms window: consecutive blocks of one render share them, while a re-render much later starts fresh - otherwise a stale "already linked" entry would keep new links from ever appearing.

**Stemming fix: the result no longer shrinks on every pass**

The correct stem of `caresses` is `caress`. The old code built the new ending and then sliced again using the stale index, cutting one of the two `s` characters it had just appended: the result was `cares`, and stemming it again gave `care` - a little shorter every time. Words ending in `s` were affected the same way (`press` was trimmed to `pres`).

It now truncates directly (`sses -> ss` and `ies -> i` both just drop the trailing `es`), so results are stable. Only users with stemming enabled and matching such words are affected, and they move from a wrong stem to the right one.

**Unit tests added**

`npm test` covers stemming, `stripHeadingNumber` and `checkWordBoundary`. One of them guards against a regression: it asserts a time limit for a heading-number-shaped input, so stripping heading numbers can never go back to the exponential-backtracking regexp that used to freeze the preview.

Also removed a method that was defined but never called (`isFormattingChar`), and clarified a TODO in reading mode that had already been implemented.
