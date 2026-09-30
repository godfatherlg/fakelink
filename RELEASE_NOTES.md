# 1.23.59

## 中文

**内部整理（续）：启动流程拆分，功能完全不变**

承接前三版，这次把插件启动（`onload`）里堆在一起的代码拆成了若干**具名步骤**。

- **没有任何行为变化** —— 启动时的注册顺序与拆分前逐行一致
- `onload` 从 1024 行降到 655 行，现在开头就是一张可读的启动清单：

  ```
  await this.loadSettings();

  this.applyStartupAppearance();
  this.registerWorkspaceEvents();
  this.registerIndexWatchers();
  this.registerLinkers();

  this.registerIndentBackground();
  this.registerCommentSpaceTrim();
  ...
  ```

- 抽出的方法：外观与颜色、workspace 事件、索引监听、linker 注册、Tab 缩进背景、
  `%%` 注释去空格、adv-uri 链接点击、adv-uri 协议、菜单注册、命令注册
- 仍然只是为了可维护性

## English

**Internal cleanup, continued: startup split into named steps, no behaviour changes**

Following the previous releases, the code that had piled up inside the plugin
startup (`onload`) was split into a set of **named steps**.

- **Nothing behaves differently** — the order of the registrations at startup is
  line-for-line what it was
- `onload` went from 1024 to 655 lines, and now opens with a readable checklist:

  ```
  await this.loadSettings();

  this.applyStartupAppearance();
  this.registerWorkspaceEvents();
  this.registerIndexWatchers();
  this.registerLinkers();

  this.registerIndentBackground();
  this.registerCommentSpaceTrim();
  ...
  ```

- Extracted: appearance and colors, workspace events, index watchers, linker
  registration, Tab-indent background, `%%` comment trimming, adv-uri link
  clicks, adv-uri protocol, menu registration, command registration
- Again: maintainability only
