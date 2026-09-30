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

/** Whether a row is a table separator row (| --- |, | :---: |, ...). */
function isSeparatorRow(line: string): boolean {
    return /^\|[\s\-:|]+\|$/.test(line.trim());
}

/** Split a table row into cells, keeping the | inside nested wikilinks intact. */
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
 * Normalize a cell's text so the DOM side and the source side can be compared.
 * Markdown syntax in the source (**bold**, ==highlight==, ~~strike~~, `code`,
 * <br>, escaped \|) is gone in the rendered DOM, so it is flattened first:
 * <br> becomes a newline, the other markers are stripped, whitespace is
 * normalized.
 */
function normalizeForCompare(s: string): string {
    return s
        // Links: the DOM renders them as plain display text, so the source must
        // be reduced to display text first to match. Table cells are full of
        // wikilinks like [[Media Note...]]; without this reduction the signature
        // never matches and whole blocks get skipped, breaking most conversions.
        .replace(/!\[\[[^\]]*\]\]/g, '')                 // embed ![[image]] -> no text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // embed ![](url) -> no text
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')   // [[note|display]] -> display
        .replace(/\[\[([^\]]+)\]\]/g, '$1')              // [[note]] -> note
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // [text](url) -> text
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
 * Extract the "plain text" of a DOM cell: keep <br> newlines but drop the
 * reference list ([1][2]... / [...]) and suffix icon that a virtual link
 * renders, otherwise they inject content that never existed in the source and
 * same-name cells fail to match.
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

    // While a cell is open for editing (cell editor active), the td holds both
    // the original text and the cell-editor text, so walking the cell reads the
    // content twice. The two copies differ only in whitespace (one has spaces
    // around <br>, the other is CodeMirror lines joined without them). When a
    // duplicate is detected keep only the first half - the whitespace-bearing
    // one, which is what corresponds to the <br> in the source.
    // Use the leading run (up to the first whitespace - present in both copies
    // and whitespace-free) as a marker, then find its second occurrence: what
    // precedes it is the complete first copy. "Half the length" does not work
    // because the two copies differ in length (one carries whitespace).
    const firstSpace = result.search(/\s/);
    const markEnd = firstSpace > 0 ? firstSpace : Math.min(16, result.length);
    const mark = result.slice(0, markEnd);
    if (mark.length >= 8) {
        const second = result.indexOf(mark, mark.length);
        // Only a second occurrence in the latter half counts as a duplicate
        if (second > 0 && second >= result.length / 2 - mark.length) {
            result = result.slice(0, second);
        }
    }

    return normalizeForCompare(result);
}

/**
 * Signature of a DOM row (tr): the plain text of every cell, non-empty ones
 * joined with |. Matching this against the source is far more distinctive than
 * a single cell - two tables can both contain "Leibniz criterion", but a whole
 * row (with its other columns) almost never matches.
 */
function getRowSignature(tr: Element): string {
    return Array.from(tr.children)
        .map(child => getCellPlainText(child))
        .filter(Boolean)
        .join('|');
}

/** Signature of a source row: cells flattened of markdown syntax, non-empty ones joined with |. */
function getSourceRowSignature(cells: string[]): string {
    return cells
        .map(c => normalizeForCompare(c))
        .filter(Boolean)
        .join('|');
}

/**
 * Locate the { line, ch } of an origin-text inside a table cell. A read-mode
 * table link's from/to are text-node offsets within the cell, which cannot be
 * used for an editor replacement directly; resolve them to a source cell via the
 * DOM row/column, then search origin-text inside that cell. Returns a position
 * rather than an offset so offsetToPos cannot produce an out-of-range position
 * under a cell editor whose document has been temporarily rewritten.
 *
 * A document can hold several tables, and the number of tables rendered in the
 * DOM does not have to equal the number of source table blocks (folded /
 * specially rendered tables are absent from the DOM), so "the Nth table in the
 * DOM" cannot map to "the Nth source block". Instead every source block is
 * tried: locate by DOM row/column and verify with origin-text; the first block
 * that verifies is the target.
 */
function locateTableCellPosition(linkElement: Element, editor: Editor): { from: EditorPosition; to: EditorPosition } | null {
    const td = linkElement.closest('td, th');
    const originText = linkElement.getAttribute('origin-text') || '';
    const tr = td?.closest('tr') ?? null;
    const table = td?.closest('table') ?? null;
    if (!td || !originText || !tr || !table) return null;

    // DOM row / column
    const cellIndex = Array.from(tr.children).indexOf(td);
    const allRows = Array.from(table.querySelectorAll('tr'));
    const domRowIndex = allRows.indexOf(tr);
    if (domRowIndex < 0) return null;

    const lines = editor.getValue().split('\n');

    // Plain text of the DOM cell (with <br> newlines, reference list / suffix removed), used as the full-match anchor.
    const domCellText = getCellPlainText(td);

    // A cell can contain several virtual links with the same name. Searching by
    // origin-text alone would always hit the first, so first determine WHICH
    // same-name link was clicked (its index within the cell) and skip the
    // preceding ones while locating.
    const cellLinks = Array.from(td.querySelectorAll('.virtual-link-a'))
        .filter(a => a.getAttribute('origin-text') === originText);
    let occurrence = cellLinks.indexOf(linkElement);
    if (occurrence < 0) occurrence = 0;

    // Split the source into table blocks (a block is consecutive `|` rows)
    const blocks: { start: number; end: number }[] = [];
    let inBlock = false;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const isRow = lines[i].trim().startsWith('|');
        if (isRow && !inBlock) { inBlock = true; start = i; }
        else if (!isRow && inBlock) { inBlock = false; blocks.push({ start, end: i }); }
    }
    if (inBlock) blocks.push({ start, end: lines.length });

    // Signature of this table's header row (the first tr). Match it against the
    // source to find the right block, then locate inside it - steadier than
    // trial-and-error per cell, and same-name tables no longer get mistaken for
    // the first block.
    const headerTr = table.querySelector('tr');
    const tableSignature = headerTr ? getRowSignature(headerTr) : '';

    // Try each block: compare the header-row signature first, and only locate by row/column inside the block that matches.
    for (const block of blocks) {
        // The block's header row = its first non-separator row
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
 * Locate inside one source table block by DOM row/column (domRowIndex /
 * cellIndex) and verify with origin-text. Returns null when the verification
 * fails (that row/column cell does not contain origin-text), so the caller can
 * try the next block.
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
    // The domRowIndex-th non-separator row in the block (separator rows do not render as tr, so they are skipped)
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
    const mdCellIndex = cellIndex + 1; // cells[0] is the empty string before the leading |
    if (mdCellIndex >= cells.length) return null;

    const rawCell = cells[mdCellIndex];
    const cellContent = rawCell.trim();

    // Cell verification: accept as soon as origin-text is found in the cell.
    // It used to also require the whole flattened cell to equal the DOM exactly,
    // but while a cell is open for editing the DOM side reads duplicate text
    // (original + cell editor), so a full match never holds and many valid
    // conversions were wrongly rejected. The block is already pinned by its
    // header signature (same-name tables cannot be mismatched), so full-cell
    // equality is no longer required.
    //
    // A cell can hold several same-name links: skip the first `occurrence` and
    // hit the one the user clicked, otherwise only the first link in the cell
    // would ever be converted.
    let cellTextIndex = -1;
    let searchFrom = 0;
    for (let k = 0; k <= occurrence; k++) {
        const idx = cellContent.indexOf(originText, searchFrom);
        // The cell has fewer same-name occurrences (e.g. the DOM side also
        // counted a word inside a wikilink path): fall back to the last one
        // found rather than giving up, which would look like "cannot convert".
        if (idx < 0) break;
        cellTextIndex = idx;
        searchFrom = idx + 1;
    }
    if (cellTextIndex < 0) return null;

    // Start of the cell content within the row: after the mdCellIndex-th |,
    // skipping leading spaces. Must skip | inside wikilinks and escaped \| just
    // like splitTableRow does.
    let cellStartCh = 0;
    let pipeCount = 0;
    let inLink = false;
    for (let c = 0; c < targetLine.length; c++) {
        const ch = targetLine[c];
        const nx = targetLine[c + 1];
        if (ch === '[' && nx === '[') { inLink = true; }
        else if (ch === ']' && nx === ']' && inLink) { inLink = false; }
        else if (ch === '\\' && nx === '|') { c++; continue; }   // skip escaped \|
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

    // Table cell: a read-mode link's from/to are text-node offsets within the
    // cell and cannot be used for an editor replacement; resolve to { line, ch }
    // via DOM row/column. Use a position rather than offsetToPos so a cell
    // editor whose document is temporarily rewritten cannot yield an
    // out-of-range offset.
    if (linkElement.closest('td, th') && editor) {
        const pos = locateTableCellPosition(linkElement, editor);
        if (!pos) {
            // On failure never fall back to offsetToPos(from/to) below: those
            // two values are in-cell text-node offsets (tiny numbers) and would
            // be read as absolute document offsets, moving the link to the very
            // top of the document. Better not to convert than to convert in the
            // wrong place.
            return;
        }
        fromEditorPos = pos.from;
        toEditorPos = pos.to;
    }

    // Non-table case: from/to are absolute document offsets, convert with offsetToPos
    if (!fromEditorPos || !toEditorPos) {
        fromEditorPos = editor?.offsetToPos(from);
        toEditorPos = editor?.offsetToPos(to);
    }

    if (!fromEditorPos || !toEditorPos) {
        return;
    }

    // Table cell: a | inside the wikilink must be escaped to \| or the table
    // treats it as a column separator; and while a cell is open for editing,
    // editor.replaceRange is routed to the cell editor and the position goes out
    // of range. Write the file with vault.modify instead, bypassing the editor
    // (including the cell editor) entirely.
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
