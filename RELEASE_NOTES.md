# 1.23.30

## 中文

- **内部清理（无功能变化）**：删掉三处已无人使用的代码（两个导出但从未被调用的函数，以及一个只为早已移除的诊断服务的辅助函数与其参数），净减少约 50 行。
- **去掉重复动作**：在编辑器里点击虚拟链接时，"重新跳转"改为**只在实测对齐找不到标题时**才执行 —— 以前它可能与纠正动作同时发生并互相抢视图；预留释放后的高度测量也合并为一次。
- **性能**：判断"本屏图片是否都已加载"的结果缓存 1.5 秒（不再每次检查都全量扫描滚动区，这对嵌入很多的笔记更友好）；四个全局 DOM 观察器合并为一个 —— 全应用每次 DOM 变化只触发一次回调，而不是四次。
- 除此之外行为与 1.23.29 相同。如果你当前版本一切正常，这一版可以跳过。

## English

- **Internal cleanup, no functional change**: removed three pieces of dead code (two exported functions that nothing ever called, plus a helper and a parameter that existed only for diagnostics that were deleted long ago) - about 50 lines lighter.
- **No more duplicated work**: clicking a virtual link inside the editor now re-navigates **only when the measured alignment cannot find the heading** - it used to be able to fire at the same time and fight the correction - and the height measurement taken after a reservation is released now happens once instead of twice.
- **Performance**: the "are all images in this surface loaded?" check is cached for 1.5 seconds instead of re-scanning the whole scroll area on every check (which matters in notes full of embeds), and the four global DOM observers were merged into one, so a DOM change anywhere in the app runs one callback instead of four.
- Otherwise identical to 1.23.29. Skip this one if everything is already working for you.
