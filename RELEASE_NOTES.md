# 1.24.23

## 中文

新增「文件夹词库隔离」，并修复紧跟链接后的文字无法成为虚拟链接的问题。

- **文件夹词库隔离**（设置 → Files）：开启后，**所有一级文件夹默认各自成为一个独立词库**，可以在下方逐个关闭。scope 内的笔记只链接同 scope 的笔记、全局笔记（不在任何 scope 中的笔记），互不串味。
- **自定义隔离文件夹**：填写更深的路径（如 `工作/项目A`）会**取消它所有父级文件夹的 scope**——「工作」及其所有上级恢复为普通文件夹，不相关的一级 scope 不受影响。
- **真实链接目标放行**：scope 内的笔记还可以链接到它用真实链接（`[[...]]`）引用过的文件，**别名、标题、块引用、嵌入都算**；只放行直接目标，不级联、不改变归属。该行为可单独关闭。
- **修复**：紧跟在 `[[链接]]` 后面的文字（中间没有空格或标点）此前无法成为虚拟链接——排除区间使用了半开坐标却被当作闭区间处理，吞掉了 `]]` 后的第一个字符。阅读模式与批量转换中的同类区间已一并修正。

## English

Adds folder dictionary isolation and fixes text typed right after a link never becoming a virtual link.

- **Folder dictionary isolation** (Settings -> Files): every top-level folder is its own dictionary by default once enabled, and each one can be switched off. A note inside a scope only links to notes of its own scope and to global notes (notes outside every scope).
- **Custom scope folders**: a deeper path such as `Work/Project A` cancels the scope of all its parent folders - "Work" and every folder above it become plain folders again, while unrelated top-level scopes stay.
- **Real link targets**: a note inside a scope may also link to the files it references with a real `[[link]]` - aliases, headings, blocks and embeds all count. Direct targets only; nothing cascades and no scope is re-assigned. This can be switched off.
- **Fixed**: text typed directly after a `[[link]]` (with no separator) could not become a virtual link - the exclusion range used a half-open end but was treated as closed, swallowing the first character after `]]`. The same ranges in Reading view and batch conversion were corrected too.
