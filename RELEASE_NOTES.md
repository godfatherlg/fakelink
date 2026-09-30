# 1.23.60

## 中文

**内部整理（收尾）：启动清单化，功能完全不变**

承接四版内部整理，这次把插件启动（`onload`）彻底精简了。

- **没有任何行为变化** —— 代码只是换了位置，执行顺序与之前逐行一致
- `onload` 从最初的 1024 行降到最后 **21 行**，现在就是一张可读的启动清单：

  ```
  async onload() {
      await this.loadSettings();

      this.applyStartupAppearance();
      this.registerWorkspaceEvents();
      this.registerIndexWatchers();
      this.registerLinkers();

      this.registerIndentBackground();
      this.registerCommentSpaceTrim();

      this.addSettingTab(new LinkerSettingTab(this.app, this));

      this.registerAdvUriLinkClicks();

      this.registerEmbedReservation();

      this.registerAdvUriProtocol();
      this.registerContextMenus();
      this.registerCommands();
  }
  ```

- 嵌入尺寸预留 / PDF 测量 / 图片尺寸 / 悬停预览对齐这套逻辑（634 行）整体移入
  `registerEmbedReservation()`。它们共用同一个 `MutationObserver` —— 拆成四个
  观察器会对全应用每一次 DOM 变化跑四个回调 —— 因此作为一个整体保留，内部未改动
- 仍然只是为了可维护性

## English

**Internal cleanup, finished: startup is a checklist, no behaviour changes**

Following four releases of internal cleanup, the plugin startup (`onload`) was
finally slimmed down.

- **Nothing behaves differently** — the code only moved; the execution order is
  line-for-line what it was
- `onload` went from 1024 lines to **21**: it is now a readable checklist:

  ```
  async onload() {
      await this.loadSettings();

      this.applyStartupAppearance();
      this.registerWorkspaceEvents();
      this.registerIndexWatchers();
      this.registerLinkers();

      this.registerIndentBackground();
      this.registerCommentSpaceTrim();

      this.addSettingTab(new LinkerSettingTab(this.app, this));

      this.registerAdvUriLinkClicks();

      this.registerEmbedReservation();

      this.registerAdvUriProtocol();
      this.registerContextMenus();
      this.registerCommands();
  }
  ```

- The embed size reservation / PDF measurement / image sizing / hover-preview
  alignment machinery (634 lines) moved as one piece into
  `registerEmbedReservation()`. Those reactions share a single `MutationObserver`
  — four separate ones would run four callbacks for every DOM change anywhere in
  the app — so they stay one unit, unchanged inside
- Again: maintainability only
