# 1.23.43

## 中文

**修复：清理一处冗余的类型断言**

- `isLinkingDisabledInNote` 里把 `cache.frontmatter` 断言成 `Record<string, unknown> | undefined` 是多余的 —— 它并不改变表达式类型，TypeScript 会持续给出 "assertion is unnecessary" 警告。
- 改为显式类型标注，顺带把 `any` 收窄为 `unknown`，后续取值不会再把 `any` 传播出去。
- 纯代码清理，行为无任何变化。

## English

**Fixed: removed a redundant type assertion**

- In `isLinkingDisabledInNote`, asserting `cache.frontmatter` to `Record<string, unknown> | undefined` was unnecessary (it does not change the type of the expression) and kept raising an "assertion is unnecessary" warning.
- Replaced with an explicit type annotation, which also narrows `any` to `unknown` so it no longer propagates.
- Code cleanup only; no behaviour change.
