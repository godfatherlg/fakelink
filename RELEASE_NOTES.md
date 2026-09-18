# 1.23.25

## 中文

- **内部维护：新增一键发布脚本 `release.ps1`**（开发者工具，不进入插件运行逻辑，不影响任何行为）。发布流程固定为：更新本文件 → 升版 → 提交 → 打标签 → 推送，随后由 GitHub Actions 自动构建并发布。
- **本版本无功能变化**，不需要重新配置任何设置；如果你没有遇到问题，可以跳过它。

## English

- **Internal: a one-command release script (`release.ps1`) was added.** It is a developer tool and is not part of the plugin's runtime behaviour. The flow is now: update this file, bump, commit, tag, push - GitHub Actions then builds and publishes.
- **No functional changes** in this version; no settings need to be touched. Skip it unless you are curious.
