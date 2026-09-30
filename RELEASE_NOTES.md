# 1.23.56

## 中文

**内部整理：功能完全不变**

把"生成虚拟链接"的那部分代码（原本 800 多行）从 `virtualLinkDom.ts` 拆到了独立模块 `virtualLinkMatch.ts`。

- **没有任何行为变化** —— 链接怎么显示、怎么点击、怎么预览，都和上一版一模一样
- 原文件从 1790 行降到 932 行
- 这只是为了让代码更好维护，为后续继续拆分做准备

如果你更新后感觉任何地方和以前不一样，请开 issue 告诉我 —— 这类改动理应无感，有异常就是我搬漏了。

## English

**Internal cleanup: no behaviour changes**

The code that builds virtual links (over 800 lines) moved out of `virtualLinkDom.ts` into its own module, `virtualLinkMatch.ts`.

- **Nothing behaves differently** — how links are rendered, clicked and previewed is exactly as in the previous release
- The original file went from 1790 to 932 lines
- This is groundwork to keep the plugin maintainable

If anything feels different after updating, please open an issue — a change like this should be invisible, so anything you notice means I missed something during the move.
