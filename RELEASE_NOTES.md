# 1.24.28

## 中文

维护版本：界面无变化，只把元素创建方式调整成社区审核可以接受的形式。

- **元素创建不再调用 `createElement`**：10 处游离的虚拟链接元素（根 span、`<a>` 锚、`<sup>` 图标）改为把一个用完即弃的 `DocumentFragment` 作为 `createEl` 的接收者。元素仍然保持游离（由 CodeMirror 接收后再挂载），仍然建在 `activeDocument` 上，同时避开了「Document 接收者」导致的 `HierarchyRequestError: Only one element on document allowed`。
- **移除 `eslint-disable` 注释**：审核明确禁止禁用 `obsidianmd/prefer-create-el`（"Disabling 'obsidianmd/prefer-create-el' is not allowed"），上一版添加的 10 条注释已全部删除，规则本身不再被触发。
- **无行为变化**：界面逻辑与 1.24.27 一致。

## English

Maintenance release: nothing changes on screen, only the way elements are created is moved into a form the community review accepts.

- **Element creation no longer calls `createElement`**: the ten detached virtual-link elements (root span, `<a>` anchor, `<sup>` icon) now pass a throwaway `DocumentFragment` as the receiver of `createEl`. The elements stay detached (CodeMirror receives them built and appends them afterwards) and are still forged on `activeDocument`, while the "Document receiver" case that throws `HierarchyRequestError: Only one element on document allowed` is avoided.
- **The `eslint-disable` comments are gone**: the review rejects disabling `obsidianmd/prefer-create-el` ("Disabling 'obsidianmd/prefer-create-el' is not allowed"), so the ten comments from the previous release are removed and the rule is no longer triggered at all.
- **No behaviour change**: the on-screen logic is the same as 1.24.27.
