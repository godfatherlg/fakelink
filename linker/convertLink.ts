import { App, Editor, EditorPosition, MarkdownView, TAbstractFile, TFile } from 'obsidian';

import type { LinkerPluginSettings } from '../main';

// Obsidian compatible path utility functions (mirrored from main.ts so this
// module stays dependency-free and importable from both main.ts and
// virtualLinkDom.ts without creating an import cycle).
function dirname(filePath: string): string {
    const lastSlashIndex = filePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? '' : filePath.substring(0, lastSlashIndex);
}

function basename(filePath: string): string {
    const lastSlashIndex = filePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);
}

function relative(from: string, to: string): string {
    // Simplified relative path calculation for Obsidian environment
    if (from === to) return '';

    const fromParts = from.split('/').filter(part => part !== '');
    const toParts = to.split('/').filter(part => part !== '');

    // Find common prefix
    let commonLength = 0;
    while (commonLength < fromParts.length &&
           commonLength < toParts.length &&
           fromParts[commonLength] === toParts[commonLength]) {
        commonLength++;
    }

    // Calculate number of parent directories to go up
    const upLevels = fromParts.length - commonLength;
    const downParts = toParts.slice(commonLength);

    // Construct relative path
    const upPath = upLevels > 0 ? '../'.repeat(upLevels) : './';
    const downPath = downParts.join('/');

    return downPath ? upPath + downPath : upPath.slice(0, -1); // Remove trailing '/'
}

/** 表格分隔行（如 | --- | :---: |）判断 */
function isSeparatorRow(line: string): boolean {
    return /^\|[\s\-:|]+\|$/.test(line.trim());
}

/** 拆分表格行为单元格数组，处理嵌套 wikilink 里的 |（避免误拆） */
function splitTableRow(line: string): string[] {
    const cells: string[] = [];
    let cur = '';
    let inLink = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const n = line[i + 1];
        if (c === '[' && n === '[') { inLink = true; cur += c; }
        else if (c === ']' && n === ']' && inLink) { inLink = false; cur += c; }
        else if (c === '|' && !inLink) { cells.push(cur); cur = ''; }
        else cur += c;
    }
    cells.push(cur);
    return cells;
}

/**
 * 把一段单元格文本规范化，用于 DOM 侧和源码侧互相比较。源码里的 markdown 语法
 * （**加粗**、==高亮==、~~删除线~~、`代码`、<br>、转义 \|）在 DOM 里都被渲染掉了，
 * 所以比较前先把它们抹平：<br> 换成换行，其余语法标记直接去掉，空白归一化。
 */
function normalizeForCompare(s: string): string {
    return s
        // 链接：DOM 里已渲染成纯显示文本，源码必须先还原成显示文本才能对上。
        // 表格单元格里大量是 [[Media Note...]] 这类 wikilink，不还原的话签名
        // 永远不匹配，整块会被跳过，导致绝大多数转换定位失败。
        .replace(/!\[\[[^\]]*\]\]/g, '')                 // 嵌入 ![[图片]] → 无文本
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // 嵌入 ![](url) → 无文本
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')   // [[笔记|显示文本]] → 显示文本
        .replace(/\[\[([^\]]+)\]\]/g, '$1')              // [[笔记]] → 笔记
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // [文本](url) → 文本
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\*\*/g, '')
        .replace(/==/g, '')
        .replace(/~~/g, '')
        .replace(/`+/g, '')
        .replace(/\\\|/g, '|')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 提取 DOM 单元格的"纯文本"：保留 <br> 换行，但排除虚拟链接渲染出来的引用列表
 * （[1][2]… / […]）和 suffix 图标，否则它们会把源码里根本没有的内容掺进比较，
 * 导致同名单元格匹配不上。
 */
function getCellPlainText(td: Element): string {
    let result = '';
    const collect = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (el.classList.contains('multiple-files-references')
                || el.classList.contains('multiple-files-indicator')
                || el.classList.contains('linker-suffix-icon')) {
                return;
            }
            if (el.tagName === 'BR') {
                result += '\n';
                return;
            }
            for (const child of Array.from(el.childNodes)) {
                collect(child);
            }
        }
    };
    collect(td);

    // 点进单元格（cell editor 激活）时，td 里会同时存在原始文本和 cell editor
    // 渲染的文本，遍历整格就把内容取了两遍 —— 两份只在空白上有差异（一份 <br>
    // 带空格，一份是 CodeMirror 行直接拼接无空格）。检测到重复就只保留前一半：
    // 前一半是带空白的那份，才对应源码里的 <br>。
    // 用开头一段（取到第一个空白为止 —— 这段两份都有、且不含空白）当标记，
    // 找它第二次出现的位置，那之前就是完整的第一份。不能用"取一半长度"，
    // 因为两份长度不同（一份带空白），按长度切会把第一份切坏。
    const firstSpace = result.search(/\s/);
    const markEnd = firstSpace > 0 ? firstSpace : Math.min(16, result.length);
    const mark = result.slice(0, markEnd);
    if (mark.length >= 8) {
        const second = result.indexOf(mark, mark.length);
        // 第二次出现且落在后半段，才认定是重复
        if (second > 0 && second >= result.length / 2 - mark.length) {
            result = result.slice(0, second);
        }
    }

    return normalizeForCompare(result);
}

/**
 * DOM 侧的一行（tr）签名：所有单元格纯文本，非空的用 | 拼接。用它去源码里找
 * 对应表格块，比单看一个单元格区分度更高——两个表格可以都含"莱布尼茨判别法"，
 * 但整行（含其他列）几乎不可能完全一样。
 */
function getRowSignature(tr: Element): string {
    return Array.from(tr.children)
        .map(child => getCellPlainText(child))
        .filter(Boolean)
        .join('|');
}

/** 源码侧的一行签名：单元格数组抹平 markdown 语法后，非空的用 | 拼接。 */
function getSourceRowSignature(cells: string[]): string {
    return cells
        .map(c => normalizeForCompare(c))
        .filter(Boolean)
        .join('|');
}

/**
 * 定位表格单元格里 origin-text 的 { line, ch } 位置。readMode 渲染的表格虚拟
 * 链接，from/to 是单元格内 text-node 偏移，无法直接用于 editor 替换；这里按
 * DOM 行列定位到源码表格的对应单元格，再在单元格内搜索 origin-text 算出
 * { line, ch }。直接返回 position 而不是 offset，避免 cell editor 下
 * offsetToPos 因文档被临时改动而算出超界位置。
 *
 * 一个文档里可能有多个表格，且 DOM 渲染出的 table 数量和源码表格块数量未必
 * 一致（如折叠/特殊渲染的表格不会出现在 DOM 里），所以不能用「DOM 第几个 table」
 * 去对应「源码第几个表格块」。这里改为：遍历源码所有表格块，对每个块用 DOM 行列
 * 定位并用 origin-text 校验，第一个校验通过的块就是目标块。
 */
function locateTableCellPosition(linkElement: Element, editor: Editor): { from: EditorPosition; to: EditorPosition } | null {
    const td = linkElement.closest('td, th');
    const originText = linkElement.getAttribute('origin-text') || '';
    const tr = td?.closest('tr') ?? null;
    const table = td?.closest('table') ?? null;
    if (!td || !originText || !tr || !table) return null;

    // DOM 行列
    const cellIndex = Array.from(tr.children).indexOf(td);
    const allRows = Array.from(table.querySelectorAll('tr'));
    const domRowIndex = allRows.indexOf(tr);
    if (domRowIndex < 0) return null;

    const lines = editor.getValue().split('\n');

    // DOM 单元格的纯文本（含 <br> 换行、去掉引用列表/suffix），用作完整匹配的锚点。
    const domCellText = getCellPlainText(td);

    // 同一单元格里可能有多个同名虚拟链接。只按 origin-text 搜会永远命中第一个，
    // 所以先确认"用户点的是该格里第几个同名链接"，定位时跳过前面几个。
    const cellLinks = Array.from(td.querySelectorAll('.virtual-link-a'))
        .filter(a => a.getAttribute('origin-text') === originText);
    let occurrence = cellLinks.indexOf(linkElement);
    if (occurrence < 0) occurrence = 0;

    // 拆分源码表格块（连续 `|` 行构成一个块）
    const blocks: { start: number; end: number }[] = [];
    let inBlock = false;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const isRow = lines[i].trim().startsWith('|');
        if (isRow && !inBlock) { inBlock = true; start = i; }
        else if (!isRow && inBlock) { inBlock = false; blocks.push({ start, end: i }); }
    }
    if (inBlock) blocks.push({ start, end: lines.length });

    // 当前 table 的「表头行签名」（第一个 tr）。用它去源码里匹配对应表格块，
    // 再在该块内定位——比逐个块用单元格试错更稳，同名表格也不会错配到第一个块。
    const headerTr = table.querySelector('tr');
    const tableSignature = headerTr ? getRowSignature(headerTr) : '';

    // 逐个块尝试：先比对表头签名（整行内容），匹配的块才进去做行列定位。
    for (const block of blocks) {
        // 块的表头行 = 块内第一个非分隔行
        let headerLine = -1;
        for (let i = block.start; i < block.end; i++) {
            if (!isSeparatorRow(lines[i])) { headerLine = i; break; }
        }
        if (headerLine < 0) continue;
        const headerCells = splitTableRow(lines[headerLine]);
        if (getSourceRowSignature(headerCells) !== tableSignature) continue;

        const pos = locateInTableBlock(lines, block, domRowIndex, cellIndex, originText, domCellText, occurrence);
        if (pos) return pos;
    }
    return null;
}

/**
 * 在单个源码表格块内，按 DOM 行列（domRowIndex / cellIndex）定位，并用
 * origin-text 校验。校验失败（该块对应行列的单元格不含 origin-text）返回 null，
 * 让调用方尝试下一个块。
 */
function locateInTableBlock(
    lines: string[],
    block: { start: number; end: number },
    domRowIndex: number,
    cellIndex: number,
    originText: string,
    domCellText: string,
    occurrence: number,
): { from: EditorPosition; to: EditorPosition } | null {
    // 块内第 domRowIndex 个非分隔行（分隔行不渲染成 tr，需跳过）
    let rowCounter = 0;
    let targetDocLine = -1;
    for (let i = block.start; i < block.end; i++) {
        if (!isSeparatorRow(lines[i])) {
            if (rowCounter === domRowIndex) { targetDocLine = i; break; }
            rowCounter++;
        }
    }
    if (targetDocLine < 0) return null;

    const targetLine = lines[targetDocLine];
    const cells = splitTableRow(targetLine);
    const mdCellIndex = cellIndex + 1; // cells[0] 是行首 | 之前的空串
    if (mdCellIndex >= cells.length) return null;

    const rawCell = cells[mdCellIndex];
    const cellContent = rawCell.trim();

    // 单元格校验：只要 origin-text 能在该单元格里找到就接受。
    // 之前还要求"抹平 markdown 后整格内容必须和 DOM 完全一致"，但点进单元格
    // 时 DOM 侧会取到重复文本（原始 + cell editor 两份），整格永远对不上，
    // 于是大量正常转换被误杀。表格块的正确性已由表头签名锁定（同名表格也
    // 不会错配），这里不再卡死整格一致。
    //
    // 同一格里可能有多个同名链接：跳过前面 occurrence 个，命中用户点的那个，
    // 否则永远只会转换格子里最前面的那个。
    let cellTextIndex = -1;
    let searchFrom = 0;
    for (let k = 0; k <= occurrence; k++) {
        const idx = cellContent.indexOf(originText, searchFrom);
        // 格子里没有那么多同名出现（比如 DOM 侧多算了 wikilink 路径里的词）：
        // 用最后一个找到的兜底，不要直接放弃，否则会变成"转化不了"。
        if (idx < 0) break;
        cellTextIndex = idx;
        searchFrom = idx + 1;
    }
    if (cellTextIndex < 0) return null;

    // 单元格内容在行内的起始：第 mdCellIndex 个 | 之后，跳过前导空格。
    // 必须和 splitTableRow 一样跳过 wikilink 里的 | 和转义的 \|。
    let cellStartCh = 0;
    let pipeCount = 0;
    let inLink = false;
    for (let c = 0; c < targetLine.length; c++) {
        const ch = targetLine[c];
        const nx = targetLine[c + 1];
        if (ch === '[' && nx === '[') { inLink = true; }
        else if (ch === ']' && nx === ']' && inLink) { inLink = false; }
        else if (ch === '\\' && nx === '|') { c++; continue; }   // 跳过转义的 \|
        else if (ch === '|' && !inLink) {
            pipeCount++;
            if (pipeCount === mdCellIndex) {
                cellStartCh = c + 1;
                while (cellStartCh < targetLine.length && targetLine[cellStartCh] === ' ') cellStartCh++;
                break;
            }
        }
    }

    const fromCh = cellStartCh + cellTextIndex;
    return {
        from: { line: targetDocLine, ch: fromCh },
        to: { line: targetDocLine, ch: fromCh + originText.length }
    };
}

/**
 * Replaces the virtual link described by `linkElement` with a real
 * [[wikilink]] / [markdown link] written into the note. This is the body of
 * the "Convert to real link" context-menu action, extracted so both the
 * regular menu path (main.ts) and the table-cell take-over menu
 * (virtualLinkDom.ts) share one implementation.
 */
export function convertVirtualLinkToReal(linkElement: Element, target: TAbstractFile, app: App, settings: LinkerPluginSettings): void {
    // Get from and to position from the element
    let from = parseInt(linkElement.getAttribute('from') || '-1');
    let to = parseInt(linkElement.getAttribute('to') || '-1');

    if (from === -1 || to === -1) {
        return;
    }

    // Get the shown text
    const text = linkElement.getAttribute('origin-text') || '';
    const activeFile = app.workspace.getActiveFile();
    const activeFilePath = activeFile?.path ?? '';

    if (!activeFile) {
        return;
    }

    if (!(target instanceof TFile)) {
        return;
    }

    let absolutePath = target.path;
    let relativePath =
        relative(dirname(activeFile.path), dirname(absolutePath)) +
        '/' +
        basename(absolutePath);
    relativePath = relativePath.replace(/\\/g, '/'); // Replace backslashes with forward slashes

    // Problem: we cannot just take the fileToLinktext result, as it depends on the app settings
    const replacementPath = app.metadataCache.fileToLinktext(target, activeFilePath);
    const headerId = linkElement.getAttribute('data-heading-id');

    // The last part of the replacement path is the real shortest file name
    // We have to check, if it leads to the correct file
    const lastPart = replacementPath.split('/').pop();
    const shortestFile = app.metadataCache.getFirstLinkpathDest(lastPart || '', '');
    let shortestPath = shortestFile?.path == target.path ? lastPart : absolutePath;

    // Remove superfluous .md extension and add headerId if exists
    const pathSuffix = headerId ? `#${headerId}` : '';
    if (!replacementPath.endsWith('.md')) {
        if (absolutePath.endsWith('.md')) {
            absolutePath = absolutePath.slice(0, -3);
        }
        if (shortestPath && shortestPath.endsWith('.md')) {
            shortestPath = shortestPath.slice(0, -3);
        }
        if (relativePath.endsWith('.md')) {
            relativePath = relativePath.slice(0, -3);
        }
        // Add headerId to all paths
        absolutePath += pathSuffix;
        shortestPath += pathSuffix;
        relativePath += pathSuffix;
    }

    const useMarkdownLinks = settings.useDefaultLinkStyleForConversion
        ? settings.defaultUseMarkdownLinks
        : settings.useMarkdownLinks;

    const linkFormat = settings.useDefaultLinkStyleForConversion
        ? settings.defaultLinkFormat
        : settings.linkFormat;

    const createLink = (replacementPath: string, text: string, markdownStyle: boolean) => {
        if (markdownStyle) {
            return `[${text}](${replacementPath})`;
        } else {
            return `[[${replacementPath}|${text}]]`;
        }
    };

    // Create the replacement
    let replacement = '';

    // If the file is the same as the shown text, and we can use short links, we use them
    if (replacementPath === text && linkFormat === 'shortest') {
        replacement = `[[${replacementPath}]]`;
    }
    // Otherwise create a specific link, using the shown text
    else {
        if (linkFormat === 'shortest') {
            replacement = createLink(shortestPath || absolutePath, text, useMarkdownLinks);
        } else if (linkFormat === 'relative') {
            replacement = createLink(relativePath, text, useMarkdownLinks);
        } else if (linkFormat === 'absolute') {
            replacement = createLink(absolutePath, text, useMarkdownLinks);
        }
    }

    // Replace the text
    const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;

    let fromEditorPos: EditorPosition | undefined;
    let toEditorPos: EditorPosition | undefined;

    // 表格单元格：readMode 渲染的 from/to 是 cell 内 text-node 偏移，无法直接
    // 用于 editor 替换；这里按 DOM 行列定位，直接算出 { line, ch }。用 position
    // 而不是 offsetToPos，避免 cell editor 下文档被临时改动导致 offsetToPos 超界。
    if (linkElement.closest('td, th') && editor) {
        const pos = locateTableCellPosition(linkElement, editor);
        if (!pos) {
            // 定位失败时绝不能回退到下面的 offsetToPos(from/to)：那两个值是
            // 单元格内的 text-node 偏移（很小的数值），会被当成文档绝对偏移，
            // 于是把链接转到文档最开头。宁可不转，也不要转错位置。
            return;
        }
        fromEditorPos = pos.from;
        toEditorPos = pos.to;
    }

    // 非表格场景：from/to 是文档绝对偏移，用 offsetToPos 换算
    if (!fromEditorPos || !toEditorPos) {
        fromEditorPos = editor?.offsetToPos(from);
        toEditorPos = editor?.offsetToPos(to);
    }

    if (!fromEditorPos || !toEditorPos) {
        return;
    }

    // 表格单元格：wikilink 里的 | 需要转义成 \|，否则会被表格当成列分隔符拆走；
    // 且点进单元格时 editor.replaceRange 会被路由到 cell editor 导致 position 超界。
    // 直接用 vault.modify 改文件内容，彻底绕开编辑器（含 cell editor）。
    if (linkElement.closest('td, th') && activeFile && editor) {
        const doc = editor.getValue();
        const fromOffset = editor.posToOffset(fromEditorPos);
        const toOffset = editor.posToOffset(toEditorPos);
        const escapedReplacement = replacement.replace(/\|/g, '\\|');
        const newDoc = doc.slice(0, fromOffset) + escapedReplacement + doc.slice(toOffset);
        void app.vault.modify(activeFile, newDoc);
        return;
    }

    editor?.replaceRange(replacement, fromEditorPos, toEditorPos);
}
