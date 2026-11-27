# 1.24.36

## 中文

修复 1.24.33 引入的一处回归：**callout 里加粗列表项中的关键词，即使正文已经链过，也会再链一次**。

- **原因**：阅读视图按标签分批处理 callout（先是段落，再是列表项，最后才是加粗这类内联标签），而 1.24.33 的定位方式改成"从上一处继续往后找"。轮到加粗内容时，查找位置已经越过它，找不到就跳过了判断，于是照常链接。
- **修复**：往后找不到时，**退回笔记开头再找一次**。这样加粗内容仍能定位到它在全文中的真实位置，"正文已经出现过"会被正确识别；游标保持单调，不会往回退，重复行仍按顺序对应各自的出现位置。
- 之前修好的四项（三字词、行首全角空格、重复行、编辑态与渲染态一致）复测无回退；关闭「只链一次」时 callout 仍全部链接。
- 无其它行为变化，`npx eslint .` 0 错误 0 警告，45 条单元测试通过。

## English

Fixes a regression introduced in 1.24.33: **a keyword already linked in the body was linked again inside a bold bullet of a callout**.

- **Cause**: the reading view processes a callout by tag (paragraphs, then list items, then inline tags such as bold), while 1.24.33 switched the lookup to "continue from the previous match". By the time bold text was handled the cursor had already passed it, the lookup failed, and the check was skipped - so the duplicate was linked.
- **Fix**: when the forward search misses, **retry from the start of the note**. Bold text can then be located at its real position, so "already appeared in the body" is recognised again. The cursor stays monotonic (it never moves backwards), so repeated lines still map to their own occurrences.
- The earlier fixes (short keywords, leading spaces, repeated lines, edit/render consistency) were re-checked and still hold; with "Only link once" off, callouts link everything as before.
- No other behaviour change; `npx eslint .` reports 0 errors and 0 warnings, 45 unit tests pass.
