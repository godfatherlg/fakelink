# 1.23.28

## 中文

- **修复：1.23.27 引入的崩溃。** 渲染虚拟链接时可能抛出 `HierarchyRequestError: Only one element on document allowed`。原因：上一版把虚拟链接那些**游离元素**（先创建、稍后才由编辑器插入的 span / a / sup）的创建方式改成了 Obsidian 的 `createEl` 辅助函数；而该函数会被其他插件改写（例如 **Media Extended**），当它以 Document 作为接收者被调用时，会把元素直接插入整个 document，从而抛错。现在已改回 `document.createElement`，并在代码里留下注释说明原因，避免以后再被"优化"掉。
- 除此之外与 1.23.27 一致。如果你停留在 1.23.26（没有这个问题）并且不着急，可以跳过这一版；使用 Media Extended 的笔记库建议升级。

## English

- **Fix: a crash introduced in 1.23.27.** Rendering virtual links could throw `HierarchyRequestError: Only one element on document allowed`. Cause: the previous version started creating the plugin's **detached** elements (span / a / sup that are appended by the editor later) through Obsidian's `createEl` helper. Other plugins override that helper (Media Extended does), and when it is called with a Document as the receiver the element is appended to the document itself, which throws. Detached elements are now built with `document.createElement` again, with a comment explaining why, so this cannot be "tidied up" again by mistake.
- Otherwise identical to 1.23.27. Staying on 1.23.26 is fine if you do not use Media Extended; vaults that do are advised to update.
