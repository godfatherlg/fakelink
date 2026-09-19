# 1.23.32

## 中文

- **修复：全新安装的 fakelink 完全无法工作 —— 设置里没有任何设置项，虚拟链接、行跳转等功能也全都不生效。** 原因是：插件第一次运行时，插件目录里还没有 `data.json`，而读取设置的代码把这个"文件不存在"当成了正常对象处理，直接抛出异常，导致插件的加载流程在**注册设置页和各项功能之前就中断了**。从 **1.23.24** 起的所有版本都存在这个问题；已经很早装过插件（有 `data.json`）的用户不受影响，所以一直没有暴露出来。
- **同时加固**：如果 `data.json` 存在但内容损坏、无法解析，插件现在会回退到默认设置并继续加载，不再彻底失效（以前遇到损坏文件同样会导致插件"变砖"，而且因为没有设置页，用户没有任何办法自行恢复）。
- 如果你的安装目前一切正常，这一版对你的实际行为没有变化 —— 但仍建议升级：这是给**所有新用户**解封的一版。

## English

- **Fix: a fresh install of fakelink did not work at all - no settings tab, and none of the features (virtual links, line jumping, ...) were active.** On the very first run there is no `data.json` yet, and the settings loader treated that missing file as a normal object: it threw, which aborted the plugin's startup **before** the settings tab and every feature were registered. Every release since **1.23.24** was affected. Installations that already had a `data.json` were unaffected, which is why it went unnoticed.
- **Also hardened:** if `data.json` exists but is damaged and cannot be parsed, the plugin now falls back to the default settings and keeps loading instead of bricking itself - previously a damaged file had the same effect, and with no settings tab the user had no way to recover.
- If your installation is working, this release changes nothing for you - but upgrading is still recommended: it unblocks every new user.
