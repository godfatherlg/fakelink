# 1.24.35

## 中文

维护版本：界面无变化，清掉社区审核最后两条 `no-unsafe-*` 警告。

- **根因是 `String.prototype.trimStart`**：它声明在 `lib.es2019.string.d.ts`，而插件模板的 `lib` 是 `DOM / ES5 / ES6 / ES7`，没有 ES2019。审核环境按这套声明做类型检查，`trimStart` 在那里是 `error` 类型，于是同一行同时报"unsafe member access"和"unsafe call"。本地没暴露，是因为 `@types/node` 顺带引入了更后面的 lib。
- **改为正则计数**：`nodeText.match(/^\s*/)?.[0].length ?? 0`，语义与原写法一致（`\s` 含全角空格 U+3000），不再依赖 ES2019。
- **没有放宽 tsconfig**：没有往 `lib` 里加 ES2019——那只会掩盖本地问题，审核环境仍按自己的声明运行。
- 全库扫描过 `trimEnd / flat / flatMap / Object.fromEntries / padStart / replaceAll / matchAll / at`，没有其它超出范围的使用。
- 无行为变化：`npx eslint .` 0 错误 0 警告，45 条单元测试通过，callout 与只链一次的运行时用例复测一致。

## English

Maintenance release: nothing changes on screen; the last two `no-unsafe-*` warnings from the community review are cleared.

- **The cause was `String.prototype.trimStart`**: it is declared in `lib.es2019.string.d.ts`, while the plugin template's `lib` is `DOM / ES5 / ES6 / ES7` - no ES2019. The review type-checks against that lib, so `trimStart` is an `error` type there and the same line reports both "unsafe member access" and "unsafe call". It stayed invisible locally because `@types/node` pulls in later libs as a side effect.
- **Replaced by a regex count**: `nodeText.match(/^\s*/)?.[0].length ?? 0`, same meaning as before (`\s` covers the ideographic space U+3000) without depending on ES2019.
- **The tsconfig was not widened**: adding ES2019 to `lib` would only hide the problem locally; the review still runs against its own declarations.
- The codebase was scanned for `trimEnd / flat / flatMap / Object.fromEntries / padStart / replaceAll / matchAll / at` - no other out-of-range usage.
- No behaviour change: `npx eslint .` reports 0 errors and 0 warnings, 45 unit tests pass, and the callout / only-link-once runtime cases were re-checked.
