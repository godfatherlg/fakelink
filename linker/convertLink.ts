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

/**
 * 定位表格单元格里 origin-text 的 { line, ch } 位置。readMode 渲染的表格虚拟
 * 链接，from/to 是单元格内 text-node 偏移，无法直接用于 editor 替换；这里按
 * DOM 行列定位到源码表格的对应单元格，再在单元格内搜索 origin-text 算出
 * { line, ch }。直接返回 position 而不是 offset，避免 cell editor 下
 * offsetToPos 因文档被临时改动而算出超界位置。
 */
function locateTableCellPosition(linkElement: Element, editor: Editor): { from: EditorPosition; to: EditorPosition } | null {
    const td = linkElement.closest('td, th');
    if (!td) return null;

    const originText = linkElement.getAttribute('origin-text') || '';
    if (!originText) return null;

    const tr = td.closest('tr');
    const table = td.closest('table');
    if (!tr || !table) return null;

    // DOM 行列
    const cellIndex = Array.from(tr.children).indexOf(td);
    let domRowIndex = -1;
    const allRows = Array.from(table.querySelectorAll('tr'));
    allRows.forEach((row, idx) => { if (row === tr) domRowIndex = idx; });
    if (domRowIndex < 0) return null;

    const lines = editor.getValue().split('\n');

    const isSeparatorRow = (line: string) => /^\|[\s\-:|]+\|$/.test(line.trim());

    // 拆分表格行：处理嵌套 wikilink 里的 |（避免误拆）
    const splitTableRow = (line: string): string[] => {
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
    };

    // domRowIndex → 源码行（跳过非表格行与分隔行）
    let domRowCounter = 0;
    let targetDocLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim().startsWith('|')) continue;
        if (isSeparatorRow(line)) continue;
        if (domRowCounter === domRowIndex) { targetDocLine = i; break; }
        domRowCounter++;
    }
    if (targetDocLine < 0) return null;

    const targetLine = lines[targetDocLine];
    const cells = splitTableRow(targetLine);
    const mdCellIndex = cellIndex + 1; // cells[0] 是行首 | 之前的空串
    if (mdCellIndex >= cells.length) return null;

    const cellContent = cells[mdCellIndex].trim();
    const cellTextIndex = cellContent.indexOf(originText);
    if (cellTextIndex < 0) return null;

    // 单元格内容在行内的起始：第 mdCellIndex 个 | 之后，跳过前导空格
    let cellStartCh = 0;
    let pipeCount = 0;
    for (let c = 0; c < targetLine.length; c++) {
        if (targetLine[c] === '|') {
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
        if (pos) {
            fromEditorPos = pos.from;
            toEditorPos = pos.to;
        }
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
