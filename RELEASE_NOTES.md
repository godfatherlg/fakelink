# 1.23.54

## 中文

**修复：「更新了什么」提示窗口没有真正生效**

上一版（1.23.53）新增了"插件更新后弹出一个窗口，列出本版更新了什么"的功能，但那段代码被放错了位置 —— 它落在右键菜单的处理函数里，只有右键时才会执行，所以实际使用中这个窗口不会弹出。本版把它移回插件启动流程，功能才真正生效。

功能本身（上一版已加入、本版才正常工作）：

- 每次更新后弹一次，列出本版更新要点
- 底部按钮可跳转到该版本的完整更新说明
- **只在版本变化时弹一次**，不会每次启动都打扰
- **首次安装不弹**
- 内容跟随界面语言（中文 / 英文）
- 内容内置，**不联网**，离线可用

## English

**Fixed: the "what is new" dialog was never actually shown**

The previous release (1.23.53) added a dialog that lists what changed after an update, but the code landed inside a context-menu handler, so it only ran on right-click - in normal use the dialog never appeared. It now runs as part of plugin startup, and the feature finally works.

The feature itself (added last release, working from this one):

- Shown once after each update, listing what changed
- A button opens the full release notes for that version
- **Shown once per update** - not on every startup
- **Not shown on a fresh install**
- Follows the UI language (Chinese / English)
- The notes are built in, so it works **offline**
