# 1.23.48

## 中文

**内部清理：删除失去用途的常量**

上一版把"跳转后对齐"改为基线防漂移语义后，`ALIGN_MIN_GAP`（以及只使用它的 `centeredOffset`）不再有任何调用方，本版将其移除，并更新了引用该常量名的历史注释。

纯代码清理，功能与行为无任何变化。使用 1.23.47 的话无需特意升级。

## English

**Internal: removed a constant that lost its purpose**

After 1.23.47 turned post-jump alignment into baseline drift protection, `ALIGN_MIN_GAP` (and `centeredOffset`, its only consumer) no longer had any caller. This release removes them and updates the historical comments that referenced the constant name.

Code cleanup only. No functional change; nothing to upgrade for if 1.23.47 works for you.
