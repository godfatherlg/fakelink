# 1.23.31

## 中文

- **改进：标题纠正的次数上限改为"按轮次"计算。** 以前编辑器里的位置纠正有一个**全局**次数上限（6 次），因此变化很多的慢笔记可能把额度用光，之后就**不再纠正** —— 观察窗设得再大也没用。现在：只要页面安静一秒后**又发生变化**（例如很晚才渲染完的图片或 PDF），本轮预算就**重新给 6 次**；同时保留**整个观察窗内 30 次**的天花板，所以"一直抖个不停"的页面仍然会被锁住 —— 这正是该上限存在的意义（避免插件与视图互相抢滚动位置，那正是过去把 PDF 密集的笔记搞到停止渲染的原因）。
- 除此之外与 1.23.30 相同。如果你当前版本一切正常，这一版可以跳过。

## English

- **Improved: the correction budget is now counted per episode.** The editor used to allow a fixed number of position corrections in total (6), so a slow note with many changes could exhaust it and then never be corrected again - no matter how long the watch window was. Now the budget is **refilled** whenever the page has been quiet for a second and then moves again (a very late image or PDF finishing), while a **ceiling of 30** still applies across the whole watch window, so a page that never stops moving is still held back - which is the point of the limit (it prevents the plugin and the view from fighting over the scroll position, the very thing that once made a PDF-heavy note stop rendering).
- Otherwise identical to 1.23.30. Skip this one if everything is already working for you.
