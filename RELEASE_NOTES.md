# 1.24.1

## 中文

**死代码清理，功能完全不变**

清掉 lint 报告里的未使用导入，以及两个早已没有调用者的函数。

- 未使用的导入：
  - `main.ts` —— `EditorPosition`、`TFolder`、`LinkerMetaInfoFetcher`、`convertVirtualLinkToReal`，
    以及上一版把嵌入尺寸逻辑搬进 `src/embedReserve.ts` 后遗留的 6 个
    （`clearContextLock`、`getHoveredHeadingId`、`headingElementByLine`、
    `keepScrolledHeadingAligned`、`markSelfInflictedLayout`、`resolveHeadingTarget`）
  - `linker/virtualLinkDom.ts` —— `IntervalTree`、`getLinkpath`、`MatchType`、`PrefixTree`、`t`
  - `linker/virtualLinkMatch.ts` —— `App`、`Menu`、`convertVirtualLinkToReal`、
    `clearContextLock`、`isInTableCellEditor`
  - `src/contextMenu.ts` —— `Notice`、`TFile`、`LinkerPluginSettings`、`t`
- 删除两个从未被调用的函数：`isInTableEnvironment`、`isPosWithinRange`（`src/contextMenu.ts`，共 42 行）
- 修正一处注释错位：解释"为什么用 `activeDocument.createElement` 而非 `createEl`"的那段
  说明原本写在 `virtualLinkDom.ts`，但那个文件并没有 `createElement` 调用（`VirtualMatch`
  类搬走时代码走了、注释留下）。已移到真正使用它的 `virtualLinkMatch.ts`

`virtualLinkMatch.ts` 里的 10 处 `activeDocument.createElement` **保留不变**：虚拟链接的
widget 必须分离构建后再交给 CodeMirror，`createEl` 会立即把它插入文档，且被某些插件
（Media Extended）替换后会抛 `HierarchyRequestError`。理由已写在代码注释里。

5 个文件，+31 / −70（净减 39 行）。编译、12 个单元测试与 lint 均通过。

## English

**Dead code cleanup, no behaviour changes**

Removed the unused imports flagged by the linter, plus two functions that had no
callers left.

- Unused imports:
  - `main.ts` — `EditorPosition`, `TFolder`, `LinkerMetaInfoFetcher`,
    `convertVirtualLinkToReal`, and the 6 left behind when the embed-sizing code
    moved into `src/embedReserve.ts` last release (`clearContextLock`,
    `getHoveredHeadingId`, `headingElementByLine`, `keepScrolledHeadingAligned`,
    `markSelfInflictedLayout`, `resolveHeadingTarget`)
  - `linker/virtualLinkDom.ts` — `IntervalTree`, `getLinkpath`, `MatchType`,
    `PrefixTree`, `t`
  - `linker/virtualLinkMatch.ts` — `App`, `Menu`, `convertVirtualLinkToReal`,
    `clearContextLock`, `isInTableCellEditor`
  - `src/contextMenu.ts` — `Notice`, `TFile`, `LinkerPluginSettings`, `t`
- Deleted two never-called functions: `isInTableEnvironment` and
  `isPosWithinRange` (`src/contextMenu.ts`, 42 lines together)
- Fixed a misplaced comment: the explanation of why `activeDocument.createElement`
  is used instead of `createEl` sat in `virtualLinkDom.ts`, which has no
  `createElement` call at all (the code moved out with the `VirtualMatch` class,
  the comment stayed). It now lives in `virtualLinkMatch.ts`, which does use it

The 10 `activeDocument.createElement` calls in `virtualLinkMatch.ts` are
**deliberately kept**: a virtual-link widget must be built detached and handed to
CodeMirror afterwards, while `createEl` inserts it into the document immediately
and throws `HierarchyRequestError` once a plugin such as Media Extended replaces
that helper. The reasoning is written into the code.

5 files, +31 / −70 (39 lines fewer). Build, 12 unit tests and the linter all pass.
