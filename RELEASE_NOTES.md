# 1.23.53

## 中文

**新增：更新后提示「更新了什么」**

每次插件更新后，会弹出一个小窗口，列出本版的更新要点；底部有按钮可跳转到该版本的完整更新说明（GitHub release 页面）。

设计上的几点考虑，避免变成打扰：

- 只在**版本变化时弹一次**，不会每次启动都出现
- **首次安装不弹**（新用户不需要看历史版本的说明）
- 内容跟随界面语言，自动显示中文或英文
- 内容内置在插件里，**不联网**，离线也能看到

## English

**New: a "what is new" dialog after an update**

After each update, a small dialog lists what changed in the new version, with a button to the full release notes (the GitHub release page).

A few deliberate choices, so this never becomes a nuisance:

- Shown **once per update** — not on every startup
- **Not shown on a fresh install** (a new user has no use for notes about past releases)
- Follows the UI language (Chinese / English)
- The notes are **built in**, so no network request is made and it works offline
