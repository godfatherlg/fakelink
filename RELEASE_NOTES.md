# 1.24.0

## 中文

**内部整理收官：代码按模块重组，功能完全不变**

这是连续五版内部整理的收尾版。`main.ts` 从 2237 行降到 1346 行，插件启动（`onload`）
只剩一张 21 行的清单。

- **没有任何行为变化** —— 代码只是换了位置和名字，执行顺序与整理前逐行一致
- 抽出的独立模块：

  | 模块 | 内容 |
  |---|---|
  | `src/lineJump.ts` | 行跳转（`obsidian://adv-uri` 处理） |
  | `src/contextMenu.ts` | 右键菜单 |
  | `src/embedReserve.ts` | 嵌入尺寸预留 / PDF 测量 / 图片尺寸 / 悬停预览对齐 |

- 插件启动现在是这样：

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

      registerEmbedReservation(this);

      this.registerAdvUriProtocol();
      this.registerContextMenus();
      this.registerCommands();
  }
  ```

- `src/embedReserve.ts` 里的四个反应器（PDF 裁剪页、图片、markdown 嵌入、悬停预览）
  仍共用同一个 `MutationObserver` —— 拆成四个观察器会对全应用每一次 DOM 变化跑四个
  回调 —— 因此作为整体保留，内部未改动
- 每一版都通过编译、12 个单元测试与 lint 验证

## English

**Internal cleanup complete: reorganised into modules, no behaviour changes**

The closing release of five consecutive releases of internal cleanup.
`main.ts` went from 2237 to 1346 lines, and plugin startup (`onload`) is now a
21-line checklist.

- **Nothing behaves differently** — the code only moved and was renamed; the
  execution order is line-for-line what it was
- Modules extracted:

  | Module | Contents |
  |---|---|
  | `src/lineJump.ts` | line jumping (the `obsidian://adv-uri` handling) |
  | `src/contextMenu.ts` | the right-click menu |
  | `src/embedReserve.ts` | embed size reservation / PDF measurement / image sizing / hover-preview alignment |

- Startup is now:

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

      registerEmbedReservation(this);

      this.registerAdvUriProtocol();
      this.registerContextMenus();
      this.registerCommands();
  }
  ```

- The four reactions inside `src/embedReserve.ts` (PDF crops, images, markdown
  embeds, hover previews) still share one `MutationObserver` — four would run
  four callbacks for every DOM change anywhere in the app — so they stay one
  unit, unchanged inside
- Every release of this series was verified by the build, the 12 unit tests and
  the linter
