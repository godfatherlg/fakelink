## 中文

### 移除 !important（Obsidian 审核要求）

光标行的行号色块样式不再使用 `!important`：

- **背景色**改为依靠更高的选择器优先级（七层类名）覆盖 Obsidian 默认的 gutter 底色。
- **文字色**改用 `-webkit-text-fill-color`。Obsidian 自己对 `.cm-gutters` 声明了 `color: var(--text-faint) !important`，普通 `color` 无法覆盖它；而 `-webkit-text-fill-color` 直接作用于字形，可以绕开这个限制，同时我们自己的代码不再需要 `!important`。

外观与 1.24.14 完全一致。

---

## English

### Removed !important (Obsidian review request)

The cursor line's gutter chip no longer uses `!important`:

- **Background**: now relies on higher selector specificity (seven classes) to override Obsidian's default gutter surface.
- **Text colour**: uses `-webkit-text-fill-color`. Obsidian itself declares `color: var(--text-faint) !important` on `.cm-gutters`, which a plain `color` cannot beat; `-webkit-text-fill-color` paints the glyphs directly and sidesteps it, so our own code no longer needs `!important`.

The appearance is identical to 1.24.14.
