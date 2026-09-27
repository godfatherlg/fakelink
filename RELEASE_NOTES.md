# 1.23.50

## 中文

**应 Obsidian 官方审核要求，移除了对齐流程的调试日志**

上一版内置了对齐过程的调试日志（默认静默，需在控制台手动开启）。Obsidian 插件发布的官方审核指南要求"Avoid unnecessary logging to console"（避免不必要的控制台日志），本版按要求将其移除。

对齐功能本身没有任何变化。如需排查问题，完整日志代码保留在 GitHub 仓库的历史提交中，随时可以恢复。

**关于近期更新频繁**

最近版本更新集中在**中国时间的夜间**发布（深夜 API 调用费用更低），所以你可能一天内收到多个版本提示。都是小步更新，跳过中间版本直接升到最新也完全没问题。给大家带来频繁的更新提示，敬请谅解。

## English

**Removed the alignment trace logging, per the Obsidian review guidelines**

The previous release shipped a debug trace for the alignment flow (silent by default, opt-in from the console). The official Obsidian plugin review guidelines ask to "Avoid unnecessary logging to console", so it is removed in this release.

The alignment feature itself is unchanged. The full logging code stays in this repository's history and can be restored any time it is needed for diagnosis.

**About the recent burst of releases**

Recent updates have been landing during **nighttime in China** (API costs are cheaper overnight), so you may have seen several version prompts within a single day. They are all small steps; skipping straight to the latest version is always fine. Sorry for the noisy update feed, and thanks for bearing with it.
