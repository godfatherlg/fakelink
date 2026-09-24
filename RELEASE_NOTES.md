# 1.23.45

## 中文

**内部清理：标注清楚遗留字段的角色**

`backgroundTabs`（1.23.43 及更早版本的「标签页」开关）只作为迁移输入保留，用途是让老用户升级后外观保持不变。此前它带的是 `@deprecated` 标签，而那是给「对外 API 已废弃、不要再调用」用的 —— 与「迁移代码必须读它」自相矛盾，IDE 因此反复提示 `backgroundTabs is deprecated`。

现在改成普通注释，明确写出：它是遗留字段，`loadSettings` 是唯一允许读取它的地方，并且等到没有用户再从 1.23.43 或更早版本升级时即可删除。

纯注释调整，功能与行为没有任何变化。若使用 1.23.44，无需特意升级。

## English

**Internal: labelled the legacy field for what it actually is**

`backgroundTabs` (the combined "Tabs" switch of 1.23.43 and earlier) survives only as migration input, so that users upgrading keep the appearance they chose. It carried a `@deprecated` tag, which means "this API is going away, stop calling it" — the opposite of what the migration code does, and IDEs kept flagging `backgroundTabs is deprecated` at the three reads.

The tag is replaced with a plain comment stating that it is a legacy field, that `loadSettings` is the single place allowed to read it, and that it can be dropped once nobody upgrades from 1.23.43 or earlier.

Comment-only change. No functional difference; nothing to upgrade for if 1.23.44 already works for you.
