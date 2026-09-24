# 1.23.44

## 中文

**背景设置拆分成可独立开关的项**

原来「背景」是一个总开关，要么整套要、要么全部不要。现在拆成 6 项，可以只保留想要的效果：

| 设置项 | 控制的内容 |
|---|---|
| 背景（总开关） | 关闭时下面全部失效 |
| 整体底色 | 应用界面的极淡底色 |
| 行与块底色 | 列表行、Tab 缩进行（含其上一行）、表格、调用块 |
| 光标行 | 光标所在行的高亮与光标颜色 |
| 标签页强调 | 激活标签页头部的强调样式 |
| 失焦蒙版 | 窗口未聚焦时的压暗层 |

两个强度滑块跟随后面的两个主项显示/隐藏。已经开启背景的用户升级后外观不变。

**调用块底色扩展到所有类型**

以前只有 `[!note]` 有底色，其它类型（tip / warning / quote 等）都没有 —— 现在全部生效。

**标签页强调的优化**

- 强调下划线由 `border-bottom` 改为 inset 阴影：原来每次切换标签都会把标题内容上下顶动 3px，现在没有任何布局开销。
- 修复非活动面板里标签发灰的问题：容器层的 `opacity: 0.85` 与标签自身的 `0.9` 会叠乘成 0.77，双层变淡导致看不清；现在改用独立的面板底色。
- `transition: all` 改为精确的属性列表，减少不必要的动画开销。
- 激活标签加了顶部圆角，并尊重系统的「减弱动效」设置。

**设置改动即时生效，无需重载**

- 修复 body class 只写到设置面板所在窗口的问题：现在会同步到所有窗口（含弹出窗口），启动后新开的窗口也会自动补上。
- 「标签页与失焦蒙版」合并项拆成两个独立开关后，旧配置里的 `backgroundTabs` 会自动迁移。
- 修复更新回调未注销的泄漏：每个编辑器实例注册后从不注销，越用越卡，还会重绘已经销毁的视图。
- 更新会合并：拖动滑块曾经每一步都触发一次「清索引 + 全量重绘」，现在一次连贯操作只跑一次。

## English

**The background look is now split into separate switches**

"Background" used to be all-or-nothing. It is now six settings, so you can keep only the parts you want:

| Setting | What it controls |
|---|---|
| Background (master) | Turns everything below off |
| Overall tint | The very faint tint of the app surfaces |
| Line and block tint | List lines, tab-indented lines (and the line above), tables, callouts |
| Cursor line | Highlight and caret colour of the line the cursor is on |
| Tab accent | Styling of the active tab header |
| Unfocused mask | Dimming layer while the window is unfocused |

The two strength sliders follow their own part. Users who already had the look on keep exactly the same appearance after upgrading.

**Callout tint now covers every callout type**

Only `[!note]` got the tint before; tip / warning / quote and friends were left out.

**Polish for the tab accent**

- The accent underline moved from a `border-bottom` to an inset shadow: the border was part of the box, so every tab switch nudged the label up and down by 3px.
- Fixed labels looking washed out in inactive panes: the container opacity (0.85) stacked with the per-tab one (0.9) for an effective 0.77. Both now use proper surfaces instead.
- `transition: all` narrowed down to the properties actually animated.
- Added a top radius on the active tab and honoured "reduce motion".

**Settings take effect without reloading the plugin**

- Body classes were only written to the window hosting the settings tab; they now reach every window, including ones opened later.
- The old combined "Tabs" switch was split in two; an existing `backgroundTabs` value is migrated automatically.
- Fixed a leak: each editor registered an update callback and never unregistered it, so every settings change also repainted long-closed views.
- Updates are coalesced: dragging a slider used to trigger a full rebuild per step, it now runs once per gesture.
