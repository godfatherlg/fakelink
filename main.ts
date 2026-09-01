import { App, Editor, EditorPosition, MarkdownView, Menu, Notice, Plugin, PluginSettingTab, TAbstractFile, TFile, TFolder } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './src/lang/helpers';
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem } from 'obsidian';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';
import { BatchConvertModal, BatchConvertFilesModal } from './src/batchConvert';

// Obsidian compatible path utility functions
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

// Helper function to handle table cell conversion with simplified approach
function handleTableCellConversion(targetElement: Element, app: App, settings: LinkerPluginSettings, updateManager: ExternalUpdateManager): void {
    // Get position and text information
    const from = parseInt(targetElement.getAttribute('from') || '-1');
    const to = parseInt(targetElement.getAttribute('to') || '-1');
    const text = targetElement.getAttribute('origin-text') || '';
    const headerId = targetElement.getAttribute('data-heading-id');

    if (from === -1 || to === -1) {
        return;
    }

    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        return;
    }

    // Get the target file path from the href attribute
    const href = targetElement.getAttribute('href');
    if (!href) {
        return;
    }

    // Extract file path and header from href
    let targetPath = href;
    let finalHeaderId = headerId;
    
    if (href.includes('#')) {
        const parts = href.split('#');
        targetPath = parts[0];
        finalHeaderId = parts[1] || headerId;
    }
    
    // Generate proper relative link path
    const activeFilePath = activeFile.path;
    const targetFile = app.metadataCache.getFirstLinkpathDest(targetPath, activeFilePath);
    if (!targetFile) {
        return;
    }
    
    const linkPath = app.metadataCache.fileToLinktext(targetFile, activeFilePath);
    const finalPath = finalHeaderId ? `${linkPath}#${finalHeaderId}` : linkPath;
    
    // Apply link format based on settings
    const useMarkdownLinks = settings.useDefaultLinkStyleForConversion 
        ? settings.defaultUseMarkdownLinks 
        : settings.useMarkdownLinks;
    
    let replacement = '';
    if (useMarkdownLinks) {
        // Markdown links - escape special characters in text
        const escapedText = text.replace(/[\\|]/g, '\\$&');
        replacement = `[${escapedText}](${finalPath})`;
    } else {
        // For wiki links in tables, we need to properly escape the text part
        // The issue is that special characters in the link text (especially pipe |) need to be escaped
        // when they appear in a table cell, as they can interfere with table parsing
        
        // Escape pipe character in the text to prevent table disruption
        const escapedText = text.replace(/[\\|]/g, '\\$&');
        // In table cells, escape the wiki link separator pipe to prevent table parsing issues
        replacement = `[[${finalPath}\\|${escapedText}]]`;
    }
    
    // Perform the replacement
    const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (editor) {
        let fromPos = editor.offsetToPos(from);
        let toPos = editor.offsetToPos(to);
        
        if (fromPos && toPos) {
            // Always recalculate positions for table cells to ensure accuracy
            const tableCellElement = targetElement.closest('td, th');
            
            if (tableCellElement) {
                const cellText = tableCellElement.textContent || '';
                const originText = targetElement.getAttribute('origin-text') || '';
                
                // Try to find the text in cell text, handling potential escaped characters
                let textIndex = cellText.indexOf(originText);
                if (textIndex === -1) {
                    // The text might be escaped in the cell (e.g., pipe | becomes \|)
                    // Try escaping special characters for search
                    const escapedOriginText = originText.replace(/[\\|]/g, '\\$&');
                    textIndex = cellText.indexOf(escapedOriginText);
                }
                
                if (textIndex !== -1) {
                    const docText = editor.getValue();
                    const lines = docText.split('\n');
                    
                    let targetLine = -1;
                    let preciseOffset = -1;
                    
                    // Get the table row to find a more unique identifier
                    const tableRowElement = tableCellElement.closest('tr');
                    if (tableRowElement) {
                        // Get the cell index in the DOM row
                        const cellIndex = Array.from(tableRowElement.children).indexOf(tableCellElement);
                        
                        // Get the table element and find the DOM row index
                        const tableElement = tableRowElement.closest('table');
                        let domRowIndex = -1;
                        if (tableElement) {
                            const allRows = tableElement.querySelectorAll('tr');
                            allRows.forEach((row, idx) => {
                                if (row === tableRowElement) {
                                    domRowIndex = idx;
                                }
                            });
                        }
                        
                        // Search for the table row in the document
                        // Instead of comparing row text (which differs due to link expansion),
                        // we search for lines where the cell at cellIndex matches cellText
                        
                        // Helper function to check if a line is a table separator row
                        const isSeparatorRow = (rowLine: string): boolean => {
                            const trimmed = rowLine.trim();
                            return /^\|[\s\-:]+\|$/.test(trimmed) || /^\|[\s\-:|]+\|$/.test(trimmed);
                        };
                        
                        // Helper function to split table row correctly (handle escaped pipes in links)
                        const splitTableRow = (rowLine: string): string[] => {
                            const cells: string[] = [];
                            let currentCell = '';
                            let inLink = false;
                            
                            for (let i = 0; i < rowLine.length; i++) {
                                const char = rowLine[i];
                                const nextChar = rowLine[i + 1];
                                
                                if (char === '[' && nextChar === '[') {
                                    inLink = true;
                                    currentCell += char;
                                } else if (char === ']' && nextChar === ']' && inLink) {
                                    inLink = false;
                                    currentCell += char;
                                } else if (char === '|' && !inLink) {
                                    cells.push(currentCell);
                                    currentCell = '';
                                } else {
                                    currentCell += char;
                                }
                            }
                            cells.push(currentCell);
                            return cells;
                        };
                        
                        // Collect all non-separator table rows with their DOM row index
                        // This establishes a direct mapping between DOM row index and document line
                        const nonSeparatorRows: { docLineIndex: number; domRowIndex: number }[] = [];
                        let domRowCounter = 0;
                        
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            
                            // Must be a table row (starts with |)
                            if (!line.trim().startsWith('|')) continue;
                            
                            // Skip separator rows
                            if (isSeparatorRow(line)) continue;
                            
                            nonSeparatorRows.push({
                                docLineIndex: i,
                                domRowIndex: domRowCounter
                            });
                            domRowCounter++;
                        }
                        
                        // Find the document line that corresponds to the DOM row index
                        let targetDocLine = -1;
                        for (const row of nonSeparatorRows) {
                            if (row.domRowIndex === domRowIndex) {
                                targetDocLine = row.docLineIndex;
                                break;
                            }
                        }
                        
                        // If we found the corresponding document line, verify it contains the target text
                        if (targetDocLine >= 0 && targetDocLine < lines.length) {
                            const line = lines[targetDocLine];
                            const cells = splitTableRow(line);
                            const mdCellIndex = cellIndex + 1;
                            
                            if (mdCellIndex < cells.length) {
                                const cellContent = cells[mdCellIndex].trim();
                                const cellTextIndex = cellContent.indexOf(originText);
                                
                                if (cellTextIndex !== -1) {
                                    // Calculate precise offset
                                    let offset = 0;
                                    let pipeCount = 0;
                                    
                                    for (let c = 0; c < line.length; c++) {
                                        const char = line[c];
                                        const isInWikiLink = () => {
                                            let depth = 0;
                                            for (let j = c - 1; j >= 0; j--) {
                                                if (line[j] === ']' && line[j - 1] === ']') {
                                                    depth++;
                                                    j--;
                                                } else if (line[j] === '[' && line[j - 1] === '[') {
                                                    depth--;
                                                    j--;
                                                    if (depth < 0) return true;
                                                }
                                            }
                                            return false;
                                        };
                                        
                                        if (char === '|' && !isInWikiLink()) {
                                            pipeCount++;
                                            if (pipeCount === mdCellIndex) {
                                                offset = c + 1;
                                                while (offset < line.length && line[offset] === ' ') {
                                                    offset++;
                                                }
                                                break;
                                            }
                                        }
                                    }
                                    
                                    targetLine = targetDocLine;
                                    preciseOffset = offset + cellTextIndex;
                                }
                            }
                        }
                    }
                    
                    // Fallback to original search if row-based search failed
                    if (targetLine === -1 || preciseOffset === -1) {
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line.includes('|') && line.includes(originText)) {
                                const lineTextIndex = line.indexOf(originText);
                                if (lineTextIndex !== -1) {
                                    targetLine = i;
                                    preciseOffset = lineTextIndex;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (targetLine !== -1 && preciseOffset !== -1) {
                        fromPos = { line: targetLine, ch: preciseOffset };
                        toPos = { line: targetLine, ch: preciseOffset + originText.length };
                    }
                }
            }
            
            // Validation and execution
            const currentLineText = editor.getLine(fromPos.line);
            const originalTextAtPosition = currentLineText.substring(fromPos.ch, toPos.ch);
            const expectedText = targetElement.getAttribute('origin-text') || '';
            
            if (originalTextAtPosition === expectedText) {
                editor.replaceRange(replacement, fromPos, toPos);
                updateManager.update();

                // Add post-execution verification
                window.setTimeout(() => {
                    editor.getLine(fromPos.line);
                }, 100);
            } else {
                // Text mismatch - try to find the correct position in table cell
                const tableCellElement = targetElement.closest('td, th');
                if (tableCellElement) {
                    const cellText = tableCellElement.textContent || '';
                    
                    // Try to find expected text in cell text (with escape handling)
                    let textIndex = cellText.indexOf(expectedText);
                    if (textIndex === -1) {
                        // Try with escaped version
                        const escapedExpectedText = expectedText.replace(/[\\|]/g, '\\$&');
                        textIndex = cellText.indexOf(escapedExpectedText);
                    }
                    
                    if (textIndex !== -1) {
                        // Found in cell text, now find the exact line position
                        const docText = editor.getValue();
                        const lines = docText.split('\n');
                        
                        let targetLine = -1;
                        let preciseOffset = -1;
                        
                        // Get the table row to find a more unique identifier
                        const tableRowElement = tableCellElement.closest('tr');
                        if (tableRowElement) {
                            // Get the cell index in the DOM row
                            const cellIndex = Array.from(tableRowElement.children).indexOf(tableCellElement);
                            
                            // Get the table element and find the DOM row index
                            const tableElement = tableRowElement.closest('table');
                            let domRowIndex = -1;
                            if (tableElement) {
                                const allRows = tableElement.querySelectorAll('tr');
                                allRows.forEach((row, idx) => {
                                    if (row === tableRowElement) {
                                        domRowIndex = idx;
                                    }
                                });
                            }
                            
                            // Search for the table row in the document
                            // Helper function to check if a line is a table separator row
                            const isSeparatorRow = (rowLine: string): boolean => {
                                const trimmed = rowLine.trim();
                                return /^\|[\s\-:]+\|$/.test(trimmed) || /^\|[\s\-:|]+\|$/.test(trimmed);
                            };
                            
                            // Use splitTableRow to correctly handle wiki links
                            const splitTableRow = (rowLine: string): string[] => {
                                const cells: string[] = [];
                                let currentCell = '';
                                let inLink = false;
                                
                                for (let k = 0; k < rowLine.length; k++) {
                                    const char = rowLine[k];
                                    const nextChar = rowLine[k + 1];
                                    
                                    if (char === '[' && nextChar === '[') {
                                        inLink = true;
                                        currentCell += char;
                                    } else if (char === ']' && nextChar === ']' && inLink) {
                                        inLink = false;
                                        currentCell += char;
                                    } else if (char === '|' && !inLink) {
                                        cells.push(currentCell);
                                        currentCell = '';
                                    } else {
                                        currentCell += char;
                                    }
                                }
                                cells.push(currentCell);
                                return cells;
                            };
                            
                            // Collect all non-separator table rows with their DOM row index
                            // This establishes a direct mapping between DOM row index and document line
                            const nonSeparatorRows: { docLineIndex: number; domRowIndex: number }[] = [];
                            let domRowCounter = 0;
                            
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                
                                // Must be a table row (starts with |)
                                if (!line.trim().startsWith('|')) continue;
                                
                                // Skip separator rows
                                if (isSeparatorRow(line)) continue;
                                
                                nonSeparatorRows.push({
                                    docLineIndex: i,
                                    domRowIndex: domRowCounter
                                });
                                domRowCounter++;
                            }
                            
                            // Find the document line that corresponds to the DOM row index
                            let targetDocLine = -1;
                            for (const row of nonSeparatorRows) {
                                if (row.domRowIndex === domRowIndex) {
                                    targetDocLine = row.docLineIndex;
                                    break;
                                }
                            }
                            
                            // If we found the corresponding document line, verify it contains the target text
                            if (targetDocLine >= 0 && targetDocLine < lines.length) {
                                const line = lines[targetDocLine];
                                const cells = splitTableRow(line);
                                const mdCellIndex = cellIndex + 1;
                                
                                if (mdCellIndex < cells.length) {
                                    const cellContent = cells[mdCellIndex].trim();
                                    const cellTextIndex = cellContent.indexOf(expectedText);
                                    
                                    if (cellTextIndex !== -1) {
                                        // Calculate precise offset
                                        let offset = 0;
                                        let pipeCount = 0;
                                        
                                        for (let c = 0; c < line.length; c++) {
                                            const char = line[c];
                                            const isInWikiLink = () => {
                                                let depth = 0;
                                                for (let j = c - 1; j >= 0; j--) {
                                                    if (line[j] === ']' && line[j - 1] === ']') {
                                                        depth++;
                                                        j--;
                                                    } else if (line[j] === '[' && line[j - 1] === '[') {
                                                        depth--;
                                                        j--;
                                                        if (depth < 0) return true;
                                                    }
                                                }
                                                return false;
                                            };
                                            
                                            if (char === '|' && !isInWikiLink()) {
                                                pipeCount++;
                                                if (pipeCount === mdCellIndex) {
                                                    offset = c + 1;
                                                    while (offset < line.length && line[offset] === ' ') {
                                                        offset++;
                                                    }
                                                    break;
                                                }
                                            }
                                        }
                                        
                                        targetLine = targetDocLine;
                                        preciseOffset = offset + cellTextIndex;
                                    }
                                }
                            }
                        }
                        
                        // Fallback to original search if row-based search failed
                        if (targetLine === -1 || preciseOffset === -1) {
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                if (line.includes('|') && line.includes(expectedText)) {
                                    const lineTextIndex = line.indexOf(expectedText);
                                    if (lineTextIndex !== -1) {
                                        targetLine = i;
                                        preciseOffset = lineTextIndex;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        if (targetLine !== -1 && preciseOffset !== -1) {
                            fromPos = { line: targetLine, ch: preciseOffset };
                            toPos = { line: targetLine, ch: preciseOffset + expectedText.length };
                            
                            // Retry replacement with corrected positions
                            editor.replaceRange(replacement, fromPos, toPos);
                            updateManager.update();
                            return;
                        }
                    }
                }
            }
        }
    }
}



export interface LinkerPluginSettings {
    app?: App; // Add app instance reference
    autoToggleByMode: boolean;
    advancedSettings: boolean;
    linkerActivated: boolean;
    suppressSuffixForSubWords: boolean;
    excludedExtensions: string[];
    matchAnyPartsOfWords: boolean;
    matchEndOfWords: boolean;
    matchBeginningOfWords: boolean;
    includeAllFiles: boolean;
    linkerDirectories: string[];
    excludedDirectories: string[];
    excludedDirectoriesForLinking: string[];
    virtualLinkSuffix: string;
    virtualLinkAliasSuffix: string;
    useDefaultLinkStyleForConversion: boolean;
    defaultUseMarkdownLinks: boolean; // Otherwise wiki links
    defaultLinkFormat: 'shortest' | 'relative' | 'absolute';
    useMarkdownLinks: boolean;
    linkFormat: 'shortest' | 'relative' | 'absolute';
    applyDefaultLinkStyling: boolean;
    alternativeDisplayStyle: boolean;
    includeHeaders: boolean;
    headerMatchSymbols: boolean;
    headerMatchOnlyBetweenSymbols: boolean;
    headerMatchStartSymbol: string;
    headerMatchEndSymbol: string;
    matchCaseSensitive: boolean;
    capitalLetterProportionForAutomaticMatchCase: number;
    tagToIgnoreCase: string;
    tagToMatchCase: string;
    propertyNameToMatchCase: string;
    propertyNameToIgnoreCase: string;
    tagToExcludeFile: string;
    tagToIncludeFile: string;
    excludeLinksToOwnNote: boolean;
    fixIMEProblem: boolean;
    excludeLinksInCurrentLine: boolean;
    onlyLinkOnce: boolean;
    excludeLinksToRealLinkedFiles: boolean;
    includeAliases: boolean;
    maxReferenceCount: number; // Max number of references to show
    maxReferencesToHideLink: number; // Hide link when total references exceed this
    alwaysShowMultipleReferences: boolean;
    excludedKeywords: string[]; // Keywords to exclude from virtual linking
    headerAutoAppendSuffix: boolean; // Auto-append suffix to new headers
    headerAutoAppendSymbol: string; // Symbol to append to headers
    allowLinksInHeaders: boolean; // Allow virtual links in headers
    colorOnlyDisplay: boolean; // Use color-only display for virtual links
    frontmatterExcludeProperty: string; // Frontmatter property for per-note opt-in (boolean)
    perNoteExcludeKeywords: boolean; // When enabled, excludedKeywords only apply to notes with the frontmatter property
    enableFrontmatterExcludeList: boolean; // When enabled, notes can define extra excluded keywords in frontmatter
    frontmatterExcludeListProperty: string; // Frontmatter property for per-note keyword list
    headerVirtualLinkColor: string; // Color for header virtual links
    noteVirtualLinkColor: string; // Color for note/alias virtual links
    headerJumpRetryDelay: number; // Base delay (ms) for repeated header-jump retries to fix position drift
    enableStemming: boolean; // 词义模糊匹配 (fuzzy meaning matching)
    stemmingLanguage: string; // Language for fuzzy matching ('en' | 'zh' | 'auto')
    fuzzyMatchThreshold: number; // Minimum similarity (0-100) for fuzzy matching to create a link (only used when enableStemming is on)
    fuzzyMinLength: number; // Minimum normalized length of a title/note name to be considered for fuzzy matching (shorter ones are skipped)
    skipMultipleTargets: boolean; // In batch conversion, skip virtual links pointing to multiple notes
    enableSymbolExclusion: boolean; // Exclude text between custom start/end symbols from virtual linking
    excludeSymbolStart: string; // Start symbol marking text to exclude from linking
    excludeSymbolEnd: string; // End symbol marking text to exclude from linking
    enableInternalLinkSyntax: boolean; // Recognize bare internal-link syntax like "a#b", "a#^block" as virtual links
    enableContextDisambiguation: boolean; // Limit a multi-file header match to the file named in the current paragraph
    jumpEnabled: boolean; // Intercept obsidian://adv-uri clicks to jump to a line directly
    jumpDelayMs: number; // Delay (ms) to wait for the target file to render before jumping to the line
    jumpOpenInNewTab: boolean; // When the target file is not open, open it in a new tab
    // wordBoundaryRegex: string;
    // conversionFormat
}

const DEFAULT_SETTINGS: LinkerPluginSettings = {
    autoToggleByMode: false,
    advancedSettings: true,
    linkerActivated: true,
    matchAnyPartsOfWords: true,
    matchEndOfWords: true,
    matchBeginningOfWords: true,
    suppressSuffixForSubWords: false,
    includeAllFiles: true,
    linkerDirectories: ['Glossary'],
    excludedDirectories: [],
    excludedDirectoriesForLinking: [],
    virtualLinkSuffix: '',
    virtualLinkAliasSuffix: '',
    excludedExtensions: ['.mp4'],
    useMarkdownLinks: false,
    linkFormat: 'shortest',
    defaultUseMarkdownLinks: false,
    defaultLinkFormat: 'shortest',
    useDefaultLinkStyleForConversion: true,
    applyDefaultLinkStyling: true,
    alternativeDisplayStyle: true,
    includeHeaders: true,
    headerMatchSymbols: true,
    headerMatchOnlyBetweenSymbols: false,
    headerMatchStartSymbol: '⟦',
    headerMatchEndSymbol: '⟧',
    matchCaseSensitive: false,
    capitalLetterProportionForAutomaticMatchCase: 0.75,
    tagToIgnoreCase: 'linker-ignore-case',
    tagToMatchCase: 'linker-match-case',
    propertyNameToMatchCase: 'linker-match-case',
    propertyNameToIgnoreCase: 'linker-ignore-case',
    tagToExcludeFile: 'linker-exclude',
    tagToIncludeFile: 'linker-include',
    excludeLinksToOwnNote: false,
    fixIMEProblem: true,
    excludeLinksInCurrentLine: true,
    onlyLinkOnce: false,
    excludeLinksToRealLinkedFiles: false,
    includeAliases: true,
    maxReferenceCount: 5,
    maxReferencesToHideLink: 10,
    alwaysShowMultipleReferences: false,
    excludedKeywords: [],
    headerAutoAppendSuffix: false,
    headerAutoAppendSymbol: '☱',
    allowLinksInHeaders: true,
    colorOnlyDisplay: true,
    frontmatterExcludeProperty: 'fakelink-exclude',
    perNoteExcludeKeywords: false,
    enableFrontmatterExcludeList: false,
    frontmatterExcludeListProperty: 'fakelink-exclude-keywords',
    headerVirtualLinkColor: '#517ea0',
    noteVirtualLinkColor: '#c0392b',
    headerJumpRetryDelay: 500,
    enableStemming: false,
    stemmingLanguage: 'en',
    fuzzyMatchThreshold: 80,
    fuzzyMinLength: 6,
    skipMultipleTargets: true,
    enableSymbolExclusion: false,
    excludeSymbolStart: '{',
    excludeSymbolEnd: '}',
    enableInternalLinkSyntax: false,
    enableContextDisambiguation: false,
    jumpEnabled: true,
    jumpDelayMs: 8000,
    jumpOpenInNewTab: true,
    // wordBoundaryRegex: '/[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u',
};

export default class LinkerPlugin extends Plugin {
    // Check if in Canvas view
    private isInCanvas(): boolean {
        // Only check if the current active view is Canvas
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.getViewType() === 'canvas') {
            return true;
        }

        return false;
    }

    public async handleLayoutChange() {
        if (!this.settings.autoToggleByMode) return;
        
        // Check if in Canvas view
        if (this.isInCanvas()) {
            // In Canvas view, if plugin is not activated, activate it
            if (!this.settings.linkerActivated) {
                await this.updateSettings({ linkerActivated: true });
            }
            return;
        }
        
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) return;
        
        const isPreviewMode = activeView.getMode() === 'preview';
        const isEditorMode = activeView.getMode() === 'source';
        
        // In read mode and plugin activated -> deactivate
        if (isPreviewMode && this.settings.linkerActivated) {
            await this.updateSettings({ linkerActivated: false });
        }
        // In edit mode and plugin not activated -> activate
        else if (isEditorMode && !this.settings.linkerActivated) {
            await this.updateSettings({ linkerActivated: true });
        }
    }

    // Wait until the target file's editor has rendered at least `targetLine`
    // lines, polling every 200ms until `timeoutMs` elapses. This replaces a
    // fixed sleep so small files jump immediately while large files still get
    // the full configured delay as an upper bound.
    private async waitForEditor(view: MarkdownView, targetLine: number, timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (view.editor && view.editor.lineCount() >= targetLine) {
                return true;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
        return view.editor != null;
    }

    // Open the target file (reusing its existing tab if already open, otherwise
    // opening a new tab) and, once rendered, move the cursor to `line` and
    // scroll it into view. `line` is 1-based (matching the adv-uri query).
    async jumpToLine(filepath: string, line: number) {
        const file = this.app.vault.getAbstractFileByPath(filepath);
        if (!(file instanceof TFile)) return;

        const existing = this.app.workspace.getLeavesOfType('markdown')
            .find(l => (l.getViewState().state as { file?: string })?.file === file.path);

        if (existing) {
            this.app.workspace.setActiveLeaf(existing, { focus: true });
        } else {
            const leaf = this.settings.jumpOpenInNewTab
                ? this.app.workspace.getLeaf(true)
                : this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        const targetLine = line;
        await this.waitForEditor(view, targetLine, this.settings.jumpDelayMs);

        const safeLine = Math.min(targetLine - 1, Math.max(0, view.editor.lineCount() - 1));
        view.editor.focus();
        view.editor.setCursor({ line: safeLine, ch: 0 });
        view.editor.scrollIntoView({ from: { line: safeLine, ch: 0 }, to: { line: safeLine, ch: 0 } }, true);
    }

    settings: LinkerPluginSettings;
    updateManager = new ExternalUpdateManager();

    async onload() {
        await this.loadSettings();

        // Apply alternative display style body class based on settings
        if (this.settings.alternativeDisplayStyle) {
            activeWindow.document.body.classList.add('virtual-linker-alt-style');
        }

        // Apply color-only display mode
        if (this.settings.colorOnlyDisplay) {
            activeWindow.document.body.classList.add('virtual-link-color-only');
        }

        // Always set link colors (header vs note)
        activeWindow.document.body.style.setProperty('--virtual-link-color', this.settings.noteVirtualLinkColor);
        activeWindow.document.body.style.setProperty('--virtual-link-header-color', this.settings.headerVirtualLinkColor);
        activeWindow.document.body.style.setProperty('--virtual-link-note-color', this.settings.noteVirtualLinkColor);

        // Listen for view changes
        this.registerEvent(this.app.workspace.on('layout-change', () => { void this.handleLayoutChange(); }));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => { void this.handleLayoutChange(); }));

        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
        });

        // Register the glossary linker for the read mode
        this.registerMarkdownPostProcessor((element, context) => {
            context.addChild(new GlossaryLinker(this.app, this.settings, context, element, this));
        });

        // Register the live linker for the live edit mode
        this.registerEditorExtension(liveLinkerPlugin(this.app, this.settings, this.updateManager, this));

        // Auto-trim spaces inside %% comments when alternative display style is enabled
        this.registerEditorExtension(
            EditorView.updateListener.of((update) => {
                if (!this.settings.alternativeDisplayStyle || !update.docChanged) return;
                
                // Find the affected range, expand to full lines
                let minFrom = Infinity;
                let maxTo = -Infinity;
                update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
                    if (fromB < minFrom) minFrom = fromB;
                    if (toB > maxTo) maxTo = toB;
                });
                if (minFrom === Infinity) return;
                
                const doc = update.state.doc;
                const startLine = doc.lineAt(minFrom);
                const endLine = doc.lineAt(maxTo - 1 > 0 ? maxTo - 1 : maxTo);
                
                // Scan each affected line for %% text %% patterns
                const changes: { from: number; to: number; insert: string }[] = [];
                for (let i = startLine.number; i <= endLine.number; i++) {
                    const line = doc.line(i);
                    let text = line.text;
                    if (!text.includes('%%') || !/\S/.test(text)) continue;
                    
                    // Fix %% text %% -> %%text%% (precise range replacement)
                    let searchFrom = 0;
                    while (searchFrom < text.length) {
                        const startIdx = text.indexOf('%%', searchFrom);
                        if (startIdx === -1) break;
                        
                        // Find content after %%
                        const contentStart = startIdx + 2;
                        // Find the closing %%
                        const endIdx = text.indexOf('%%', contentStart);
                        if (endIdx === -1) {
                            searchFrom = contentStart;
                            continue;
                        }
                        
                        // Extract content between %% markers and trim
                        const inner = text.slice(contentStart, endIdx);
                        const trimmed = inner.trim();
                        
                        if (trimmed !== inner) {
                            const fullFrom = line.from + startIdx;
                            const fullTo = line.from + endIdx + 2;
                            changes.push({
                                from: fullFrom,
                                to: fullTo,
                                insert: `%%${trimmed}%%`
                            });
                            // Adjust text for subsequent searches on this line
                            const before = text.slice(0, startIdx);
                            const after = text.slice(endIdx + 2);
                            text = before + `%%${trimmed}%%` + after;
                            searchFrom = startIdx + trimmed.length + 4;
                        } else {
                            searchFrom = endIdx + 2;
                        }
                    }
                }
                
                if (changes.length > 0) {
                    // Preserve selection, excluding %% markers
                    // When there is exactly one %% pair, set selection to content only
                    if (changes.length === 1) {
                        const ch = changes[0];
                        const anchor = ch.from + 2;
                        const head = ch.from + ch.insert.length - 2;
                        update.view.dispatch({ 
                            changes, 
                            selection: EditorSelection.single(anchor, head) 
                        });
                    } else {
                        update.view.dispatch({ changes });
                    }
                }
            })
        );

        // Auto-insert symbol at front of new/changed headers
        this.registerEditorExtension(
            EditorView.updateListener.of((update) => {
                if (!this.settings.headerAutoAppendSuffix || !update.docChanged) return;
                const symbol = this.settings.headerAutoAppendSymbol;
                if (!symbol) return;
                
                const doc = update.state.doc;
                let minFrom = Infinity, maxTo = -Infinity;
                update.changes.iterChanges((_a, _b, fromB, toB) => {
                    if (fromB < minFrom) minFrom = fromB;
                    if (toB > maxTo) maxTo = toB;
                });
                if (minFrom === Infinity) return;
                
                const startLine = doc.lineAt(minFrom);
                const endLine = doc.lineAt(Math.max(0, maxTo - 1));
                const changes: { from: number; to: number; insert: string }[] = [];
                
                for (let i = startLine.number; i <= endLine.number; i++) {
                    const line = doc.line(i);
                    const text = line.text;
                    // Match header with content: "# Title", "## Subtitle"
                    const match = text.match(/^(#{1,6}\s+)(\S.*)$/);
                    if (!match) continue;
                    const prefix = match[1];      // e.g., "# " or "## "
                    const content = match[2];      // e.g., "概念"
                    // Skip if symbol already present at front of content
                    if (content.startsWith(symbol)) continue;
                    // Insert symbol after prefix, before content
                    changes.push({
                        from: line.from + prefix.length,
                        to: line.from + prefix.length,
                        insert: symbol
                    });
                }
                
                if (changes.length > 0) {
                    update.view.dispatch({ changes });
                }
            })
        );

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new LinkerSettingTab(this.app, this));

        // Intercept obsidian://adv-uri link clicks to jump to a line directly,
        // bypassing Advanced URI's own (flaky) line positioning.
        this.registerDomEvent(this.app.workspace.containerEl, 'click', (evt) => {
            if (!this.settings.jumpEnabled) return;
            const a = (evt.target as HTMLElement).closest('a');
            if (!a) return;
            const href = a.getAttribute('href') || '';
            if (!href.startsWith('obsidian://adv-uri')) return;
            const p = new URLSearchParams(href.slice('obsidian://adv-uri?'.length));
            const line = parseInt(p.get('line') || '', 10);
            if (!line || line < 1) return;
            const filepath = p.get('filepath') || '';
            evt.preventDefault();
            evt.stopImmediatePropagation();
            void this.jumpToLine(filepath, line);
        }, true);

        // Context menu item to convert virtual links to real links
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source) => this.addContextMenuItem(menu, file, source)));

        this.addCommand({
            id: 'toggle-virtual-linker',
            name: 'Toggle virtual linker',
            callback: () => {
                void this.updateSettings({ linkerActivated: !this.settings.linkerActivated });
                this.updateManager.update();
            }
        });

        this.addCommand({
            id: 'toggle-header-marker',
            name: 'Toggle header marker symbol',
            callback: () => {
                void this.updateSettings({ headerAutoAppendSuffix: !this.settings.headerAutoAppendSuffix });
            }
        });

        this.addCommand({
            id: 'convert-selected-virtual-links',
            name: 'Convert all virtual links in selection to real links',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                if (!editor.somethingSelected()) {
                    new Notice('请先选择一段文本，再运行此命令。');
                    return;
                }
                if (!this.settings.linkerActivated) {
                    new Notice('虚拟链接功能当前已关闭，请先在设置中启用。');
                    return;
                }
                const fromPos = editor.getCursor('from');
                const toPos = editor.getCursor('to');
                const rangeFrom = editor.posToOffset(fromPos);
                const rangeTo = editor.posToOffset(toPos);
                const modal = new BatchConvertModal(
                    this.app,
                    this.settings,
                    this,
                    [rangeFrom, rangeTo]
                );
                modal.open();
            }
        });


        // Convert ALL virtual links in the current note to real links, with a
        // preview list so the user can uncheck any they want to keep virtual.
        this.addCommand({
            id: 'convert-all-virtual-links-preview',
            name: 'Convert all virtual links in note to real links (preview)',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                const modal = new BatchConvertModal(this.app, this.settings, this);
                modal.open();
            }
        });

        // Convert virtual links across MULTIPLE notes, chosen by the user.
        this.addCommand({
            id: 'convert-multiple-files-virtual-links',
            name: 'Convert all virtual links in multiple notes to real links',
            callback: () => {
                const modal = new BatchConvertFilesModal(this.app, this.settings, this);
                modal.open();
            }
        });

    }

    private isInTableEnvironment(editor: MarkdownView['editor'], _fromOffset: number, _toOffset: number): boolean {
        try {
            const fromPos = editor.offsetToPos(_fromOffset);
            // Check for table syntax: lines starting with | or containing | characters
            const line = editor.getLine(fromPos.line);
            const isTableLine = line.trim().startsWith('|') || line.includes('|');
            
            if (isTableLine) {
                return true;
            }
            
            // Additional check: look for table markers in surrounding lines
            const contextLines = 3;
            for (let i = Math.max(0, fromPos.line - contextLines); i <= Math.min(editor.lineCount() - 1, fromPos.line + contextLines); i++) {
                const contextLine = editor.getLine(i);
                if (contextLine.trim().startsWith('|') || contextLine.includes('|')) {
                    return true;
                }
            }
            
            return false;
        } catch {
            return false;
        }
    }

    private isPosWithinRange(
        linkFrom: EditorPosition,
        linkTo: EditorPosition,
        selectionFrom: EditorPosition,
        selectionTo: EditorPosition
    ): boolean {
        return (
            (linkFrom.line > selectionFrom.line ||
             (linkFrom.line === selectionFrom.line && linkFrom.ch >= selectionFrom.ch)) &&
            (linkTo.line < selectionTo.line ||
             (linkTo.line === selectionTo.line && linkTo.ch <= selectionTo.ch))
        );
    }

    addContextMenuItem(menu: Menu, file: TAbstractFile, _source: string) {
        // addContextMenuItem(a: any, b: any, c: any) {
        // Capture the MouseEvent when the context menu is triggered   // Define a named function to capture the MouseEvent

        if (!file) {
            return;
        }

        const app: App = this.app;
        const updateManager = this.updateManager;
        const settings = this.settings;

        const fetcher = new LinkerMetaInfoFetcher(app, settings);
        // Check, if the file has the linker-included tag

        const isDirectory = app.vault.getAbstractFileByPath(file.path) instanceof TFolder;

        if (!isDirectory) {
            const metaInfo = fetcher.getMetaInfo(file);

            const contextMenuHandler = (event: MouseEvent) => {
                // Access the element that triggered the context menu
                const targetElement = event.target;

                if (!targetElement || !(targetElement instanceof HTMLElement)) {
                    return;
                }

                // Check if clicked on multiple references indicator
                const isMultipleReferences = targetElement.classList.contains('multiple-files-references') || 
                                            targetElement.closest('.multiple-files-references') !== null;
                
                // If clicked on multiple references indicator, find the containing virtual link element
                if (isMultipleReferences) {
                    const virtualLinkSpan = targetElement.closest('.virtual-link-span') || 
                                           targetElement.closest('.virtual-link');
                    
                    if (virtualLinkSpan) {
                        // Add temporary lock class to prevent collapse
                        virtualLinkSpan.classList.add('virtual-link-hover-lock');
                        
                        // Set timer to remove lock class
                        window.setTimeout(() => {
                            virtualLinkSpan.classList.remove('virtual-link-hover-lock');
                        }, 3000); // Remove after 3 seconds to balance operation time and UI responsiveness
                    }
                }

                // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
                // Use closest to find the virtual link element even when clicking on child elements
                const virtualLinkElement = targetElement.closest('.virtual-link-a');
                const isVirtualLink = virtualLinkElement !== null;
                const isInTableCell = targetElement.closest('td, th') !== null;

                // Use the virtual link element for attribute access if found
                const linkElement = virtualLinkElement || targetElement;
                const from = parseInt(linkElement.getAttribute('from') || '-1');
                const to = parseInt(linkElement.getAttribute('to') || '-1');

                if (from === -1 || to === -1) {
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle(
                            'Converting link is not here'
                        ).setIcon('link');
                    });
                }
                // Check, if the element has the "virtual-link" class
                else if (isVirtualLink) {
                    // Always show "Add to excluded keywords" option for virtual links
                    menu.addItem((item) => {
                        // Item to add virtual link text to excluded keywords
                        item.setTitle('Add to excluded keywords')
                            .setIcon('ban')
                            .onClick(async () => {
                                const text = linkElement.getAttribute('origin-text') || '';
                                if (text) {
                                    const newExcludedKeywords = [...new Set([...settings.excludedKeywords, text])];
                                    await this.updateSettings({ excludedKeywords: newExcludedKeywords });
                                    updateManager.update();
                                }
                            });
                    });

                    // Show intelligent conversion options based on context
                    if (isInTableCell) {
                        // Table cell context - show table-safe conversion
                        menu.addItem((item) => {
                            item.setTitle('Convert to real link (table mode)')
                                .setIcon('table')
                                .onClick(() => {
                                    handleTableCellConversion(linkElement, app, settings, updateManager);
                                });
                        });
                    } else {
                        // Regular context - show standard conversion
                        menu.addItem((item) => {
                            // Item to convert a virtual link to a real link
                            item.setTitle('Convert to real link')
                                .setIcon('link')
                                .onClick(() => {
                                    // Get from and to position from the element
                                    const from = parseInt(linkElement.getAttribute('from') || '-1');
                                    const to = parseInt(linkElement.getAttribute('to') || '-1');

                                    if (from === -1 || to === -1) {
                                        return;
                                    }

                                    // Get the shown text
                                    const text = linkElement.getAttribute('origin-text') || '';
                                    const target = file;
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
                                            // Check if we are in a table environment and escape the text accordingly
                                            const tableCellElement = targetElement.closest('td, th');
                                            if (tableCellElement) {
                                                // In table cells, escape pipe characters to prevent table disruption
                                                const escapedText = text.replace(/[\\|]/g, '\\$&');
                                                // In table cells, escape the wiki link separator pipe to prevent table parsing issues
                                                return `[[${replacementPath}\\|${escapedText}]]`;
                                            } else {
                                                return `[[${replacementPath}|${text}]]`;
                                            }
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
                                    const fromEditorPos = editor?.offsetToPos(from);
                                    const toEditorPos = editor?.offsetToPos(to);

                                    if (!fromEditorPos || !toEditorPos) {
                                        return;
                                    }

                                    editor?.replaceRange(replacement, fromEditorPos, toEditorPos);
                                });
                        });
                    }
                }

                // Remove the listener to prevent multiple triggers
                activeDocument.removeEventListener('contextmenu', contextMenuHandler);
            }

            if (!metaInfo.excludeFile && (metaInfo.includeAllFiles || metaInfo.includeFile || metaInfo.isInIncludedDir)) {
                // Item to exclude a virtual link from the linker
                // This action adds the settings.tagToExcludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('Exclude this file')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter ?? {};

                            const tag = settings.tagToExcludeFile;
                            let tags: string[] | string = frontmatter['tags'] as string[] | string;

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter: Record<string, unknown> & { tags?: string[] | Set<string> }) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set<string>();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove include tag if it exists
                                    const includeTag = settings.tagToIncludeFile;
                                    if (frontMatter.tags instanceof Set && frontMatter.tags.has(includeTag)) {
                                        frontMatter.tags.delete(includeTag);
                                    }
                                }).catch(() => {});

                                updateManager.update();
                            }
                        });
                });
            } else if (!metaInfo.includeFile && (!metaInfo.includeAllFiles || metaInfo.excludeFile || metaInfo.isInExcludedDir)) {
                //Item to include a virtual link from the linker
                // This action adds the settings.tagToIncludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('Include this file')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter ?? {};

                            const tag = settings.tagToIncludeFile;
                            let tags: string[] | string = frontmatter['tags'] as string[] | string;

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter: Record<string, unknown> & { tags?: string[] | Set<string> }) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set<string>();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove exclude tag if it exists
                                    const excludeTag = settings.tagToExcludeFile;
                                    if (frontMatter.tags instanceof Set && frontMatter.tags.has(excludeTag)) {
                                        frontMatter.tags.delete(excludeTag);
                                    }
                                }).catch(() => {});

                                updateManager.update();
                            }
                        });
                });
            }

            // Capture the MouseEvent when the context menu is triggered
            activeDocument.addEventListener('contextmenu', contextMenuHandler, { once: true });
        } else {
            // Check if the directory is in the linker directories
            const path = file.path + '/';
            const isInIncludedDir = fetcher.includeDirPattern.test(path);
            const isInExcludedDir = fetcher.excludeDirPattern.test(path);

            // If the directory is in the linker directories, add the option to exclude it
            if ((fetcher.includeAllFiles && !isInExcludedDir) || isInIncludedDir) {
                menu.addItem((item) => {
                    item.setTitle('Exclude this directory')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path);

                            if (!targetFolder || !(targetFolder instanceof TFolder)) {
                                return;
                            }

                            const newExcludedDirs = Array.from(new Set([...settings.excludedDirectories, targetFolder.name]));
                            const newIncludedDirs = settings.linkerDirectories.filter((dir) => dir !== targetFolder.name);
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs }).catch(() => {});

                            updateManager.update();
                        });
                });
            } else if ((!fetcher.includeAllFiles && !isInIncludedDir) || isInExcludedDir) {
                // If the directory is in the excluded directories, add the option to include it
                menu.addItem((item) => {
                    item.setTitle('Include this directory')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path);

                            if (!targetFolder || !(targetFolder instanceof TFolder)) {
                                return;
                            }

                            const newExcludedDirs = settings.excludedDirectories.filter((dir) => dir !== targetFolder.name);
                            const newIncludedDirs = Array.from(new Set([...settings.linkerDirectories, targetFolder.name]));
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs }).catch(() => {});

                            updateManager.update();
                        });
                });
            }
        }
    }

    private cleanupVirtualLinks() {
        // Restore virtual links to original text
        const virtualLinks = activeDocument.querySelectorAll('.virtual-link, .virtual-link-span, .virtual-link-a');
        virtualLinks.forEach(link => {
            // Get original text: try origin-text attribute first, otherwise use link text content
            const anchor = link.classList.contains('virtual-link-a') ? link : link.querySelector('.virtual-link-a');
            const originalText = anchor?.getAttribute('origin-text') || anchor?.textContent || '';
            if (originalText) {
                // Replace virtual link element with text node
                const textNode = activeDocument.createTextNode(originalText);
                link.replaceWith(textNode);
            } else {
                // Delete if no text found
                link.remove();
            }
        });
        
        // Clear possible multiple reference indicators (these don't contain main text, delete directly)
        const multipleRefs = activeDocument.querySelectorAll('.multiple-files-references, .multiple-files-indicator');
        multipleRefs.forEach(ref => ref.remove());
    }

    onunload() {
        this.cleanupVirtualLinks();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LinkerPluginSettings>);

        // Load markdown links from obsidian settings
        // At the moment obsidian does not provide a clean way to get the settings through an API
        // So we read the app.json settings file directly
        // We also Cannot use the vault API because it only reads the vault files not the .obsidian folder
        try {
            const fileContent = await this.app.vault.adapter.read(this.app.vault.configDir + '/app.json');
            const appSettings = JSON.parse(fileContent) as { useMarkdownLinks?: boolean; newLinkFormat?: string };
            this.settings.defaultUseMarkdownLinks = appSettings.useMarkdownLinks ?? false;
            this.settings.defaultLinkFormat = (appSettings.newLinkFormat ?? 'shortest') as 'shortest' | 'relative' | 'absolute';
        } catch {
            // Set default values
            this.settings.defaultUseMarkdownLinks = false;
            this.settings.defaultLinkFormat = 'shortest';
        }
    }

    /** Update plugin settings. */
    async updateSettings(settings: Partial<LinkerPluginSettings> = {}) {
        Object.assign(this.settings, settings);
        
        // Create a settings object copy without circular references
        const settingsToSave = {...this.settings};
        // Remove properties that should not be serialized
        delete settingsToSave.app;
        // delete settingsToSave.appMenuBarManager;
        
        try {
            await this.saveData(settingsToSave);
        } catch {
            // Failed to save settings
        }
        
        this.updateManager.update();
        
        // If plugin is disabled, clear all virtual links
        if (!this.settings.linkerActivated) {
            this.cleanupVirtualLinks();
        }
        
        // Force refresh all views to ensure settings changes take effect immediately
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.previewMode) {
                view.previewMode.rerender(true);
            }
        });
    }
}
// ---------- Declarative settings panel (Obsidian 1.13.0+) ----------
// Shared option bag for the definition builders below.
interface DefOpts {
    desc?: string;
    visible?: () => boolean;
    disabled?: () => boolean;
    aliases?: string[];
}

function toggleDef(name: string, key: string, opts: DefOpts = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'toggle', key, disabled: opts.disabled } };
}
function textDef(name: string, key: string, opts: DefOpts & { placeholder?: string } = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'text', key, placeholder: opts.placeholder, disabled: opts.disabled } };
}
function textAreaDef(name: string, key: string, opts: DefOpts & { placeholder?: string } = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'textarea', key, placeholder: opts.placeholder, disabled: opts.disabled } };
}
function dropdownDef(name: string, key: string, options: Record<string, string>, opts: DefOpts = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'dropdown', key, options, disabled: opts.disabled } };
}
function sliderDef(name: string, key: string, min: number, max: number, step: number, opts: DefOpts = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'slider', key, min, max, step, disabled: opts.disabled } };
}
function numberDef(name: string, key: string, opts: DefOpts & { min?: number; max?: number; step?: number; placeholder?: string } = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'number', key, min: opts.min, max: opts.max, step: opts.step, placeholder: opts.placeholder, disabled: opts.disabled } };
}
function colorDef(name: string, key: string, opts: DefOpts = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'color', key, disabled: opts.disabled } };
}
function actionDef(name: string, action: () => void | Promise<void>, opts: DefOpts = {}): SettingDefinition {
    return { name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, action: () => { void action(); } };
}
function groupDef(heading: string, items: SettingGroupItem[], visible?: () => boolean): SettingDefinitionGroup {
    return { type: 'group', heading, items, visible };
}

class LinkerSettingTab extends PluginSettingTab {
    constructor(app: App, public plugin: LinkerPlugin) {
        super(app, plugin);
    }

    private get s(): LinkerPluginSettings {
        return this.plugin.settings;
    }

    // The declarative API reads/writes settings through these two methods.
    // We override them to (a) bridge fields that need a representation
    // different from their stored form, and (b) run the same side effects
    // the old imperative UI had (body classes, CSS vars, auto-toggles, etc).
    getControlValue(key: string): unknown {
        const s = this.s;
        switch (key) {
            case 'useWikilinks':
                return !s.useMarkdownLinks;
            case 'capitalLetterProportionForAutomaticMatchCase':
                return Math.round(s.capitalLetterProportionForAutomaticMatchCase * 1000) / 10;
            case 'linkerDirectories':
                return s.linkerDirectories.join('\n');
            case 'excludedDirectories':
                return s.excludedDirectories.join('\n');
            case 'excludedDirectoriesForLinking':
                return s.excludedDirectoriesForLinking.join('\n');
            case 'excludedKeywords':
                return s.excludedKeywords.join(',');
            case 'excludedExtensions':
                return s.excludedExtensions.join('\n');
            default:
                return (s as unknown as Record<string, unknown>)[key];
        }
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        let needsFullUpdate = false;
        switch (key) {
            case 'useWikilinks':
                await this.plugin.updateSettings({ useMarkdownLinks: !(value as boolean) });
                break;
            case 'capitalLetterProportionForAutomaticMatchCase':
                await this.plugin.updateSettings({ capitalLetterProportionForAutomaticMatchCase: (value as number) / 100 });
                break;
            case 'linkerDirectories':
                await this.plugin.updateSettings({ linkerDirectories: this.splitLines(value as string) });
                break;
            case 'excludedDirectories':
                await this.plugin.updateSettings({ excludedDirectories: this.splitLines(value as string) });
                break;
            case 'excludedDirectoriesForLinking':
                await this.plugin.updateSettings({ excludedDirectoriesForLinking: this.splitLines(value as string) });
                break;
            case 'excludedKeywords':
                await this.plugin.updateSettings({
                    excludedKeywords: (value as string).split(',').map((x) => x.trim()).filter((x) => x.length > 0),
                });
                break;
            case 'excludedExtensions':
                await this.plugin.updateSettings({
                    excludedExtensions: (value as string)
                        .split(/[\n,]/)
                        .map((x) => x.trim())
                        .filter((x) => x.length > 0)
                        .map((x) => (x.startsWith('.') ? x : `.${x}`)),
                });
                break;
            case 'allowLinksInHeaders':
                // Enabling header links auto-enables excluding self-links.
                await this.plugin.updateSettings({
                    allowLinksInHeaders: value as boolean,
                    ...(value ? { excludeLinksToOwnNote: true } : {}),
                });
                // excludeLinksToOwnNote's value changed too, so fully re-render.
                needsFullUpdate = true;
                break;
            case 'autoToggleByMode':
                await this.plugin.updateSettings({ autoToggleByMode: value as boolean });
                void this.plugin.handleLayoutChange();
                break;
            case 'colorOnlyDisplay':
                await this.plugin.updateSettings({ colorOnlyDisplay: value as boolean });
                this.applyBodyClass('virtual-link-color-only', value as boolean);
                break;
            case 'alternativeDisplayStyle':
                await this.plugin.updateSettings({ alternativeDisplayStyle: value as boolean });
                this.applyBodyClass('virtual-linker-alt-style', value as boolean);
                break;
            case 'headerVirtualLinkColor':
                await this.plugin.updateSettings({ headerVirtualLinkColor: value as string });
                this.applyCssVar('--virtual-link-header-color', value as string);
                break;
            case 'noteVirtualLinkColor':
                await this.plugin.updateSettings({ noteVirtualLinkColor: value as string });
                this.applyCssVar('--virtual-link-note-color', value as string);
                break;
            default:
                await this.plugin.updateSettings({ [key]: value });
        }

        if (needsFullUpdate) {
            this.update();
        } else {
            // Re-evaluate visible/disabled predicates that depend on other settings.
            this.refreshDomState();
        }
    }

    private splitLines(value: string): string[] {
        return value.split('\n').map((x) => x.trim()).filter((x) => x.length > 0);
    }

    private applyBodyClass(cls: string, on: boolean): void {
        const doc = this.containerEl.ownerDocument;
        if (on) doc.body.classList.add(cls);
        else doc.body.classList.remove(cls);
    }

    private applyCssVar(name: string, value: string): void {
        this.containerEl.ownerDocument.body.style.setProperty(name, value);
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const s = this.s;
        const adv = () => s.advancedSettings;

        const quickAddCode = `module.exports = async (params) => {
    const id = 'fakelink';
    const pm = app.plugins;

    try {
        if (pm.plugins[id]) {
            await pm.disablePlugin(id);
            new Notice('Fake Link: OFF');
        } else {
            await pm.enablePlugin(id);
            new Notice('Fake Link: ON');
        }

        // Force refresh views first, then reload plugins
        const types = ['markdown', 'canvas'];
        const leaves = types.flatMap(t => app.workspace.getLeavesOfType(t));
        for (const leaf of leaves) {
            try {
                const s = leaf.getViewState();
                await leaf.setViewState({ ...s, state: { ...s.state, forceRefresh: true } });
            } catch (_) {}
        }
        app.workspace.trigger('layout-change');
        app.workspace.activeLeaf?.rebuildView();

        app.commands.executeCommandById('app:reload-plugins');
    } catch (e) {
        new Notice('Fake Link: toggle failed, check console');
    }
};`;

        return [
            // ---------- General ----------
            groupDef(t('General'), [
                toggleDef(t('Activate virtual linker'), 'linkerActivated', {
                    desc: t('To show/hide virtual links in the body of regular notes (paragraphs, lists, etc.), please turn on/off this toggle. Note: This toggle cannot control virtual links inside tables and Canvas (due to different rendering mechanisms). If virtual links in tables or Canvas are not displayed or show rendering glitches, do not toggle this switch — simply restart the plugin (via QuickAdd or other means).'),
                }),
                actionDef(t('Copy Quick Add script'), async () => {
                    await navigator.clipboard.writeText(quickAddCode);
                    new Notice(t('Quick Add script copied to clipboard!'));
                }),
                toggleDef(t('Auto-toggle activation status by mode'), 'autoToggleByMode', {
                    desc: t('When enabled, the plugin will automatically activate in edit mode if inactive, and automatically deactivate in read mode if active'),
                }),
            ]),

            // ---------- Matching ----------
            groupDef(t('Matching behavior'), [
                toggleDef(t('Include aliases'), 'includeAliases', {
                    desc: t('If enabled, the virtual linker will also match file aliases.'),
                }),
                toggleDef(t('Match any part of a word'), 'matchAnyPartsOfWords', {
                    desc: t('When disabled, only complete word matches are linked. When enabled, any substring match will be linked.'),
                }),
                toggleDef(t('Match the beginning of words'), 'matchBeginningOfWords', {
                    desc: t('When enabled, word prefixes will be linked even without complete word matches.'),
                    visible: () => !s.matchAnyPartsOfWords,
                }),
                toggleDef(t('Match the end of words'), 'matchEndOfWords', {
                    desc: t('When enabled, word suffixes will be linked even without complete word matches.'),
                    visible: () => !s.matchAnyPartsOfWords,
                }),
                toggleDef(t('Suppress suffix for sub words'), 'suppressSuffixForSubWords', {
                    desc: t('When enabled, the link suffix will only be shown for complete word matches, not partial matches.'),
                    visible: () => s.matchAnyPartsOfWords || s.matchBeginningOfWords,
                }),
                toggleDef(t('Only link once'), 'onlyLinkOnce', {
                    desc: t('When enabled, identical terms in the same note will only be linked once.'),
                    visible: adv,
                }),
                toggleDef(t('Exclude links to real linked files'), 'excludeLinksToRealLinkedFiles', {
                    desc: t('When enabled, terms that are already manually linked in the note will not be auto-linked.'),
                    visible: adv,
                }),
                toggleDef(t('Exclude self-links to the current note'), 'excludeLinksToOwnNote', {
                    desc: t('If toggled, links to the note itself are excluded from the linker. Enabling "Allow virtual links in headers" also turns this on automatically.'),
                    visible: adv,
                }),
                toggleDef(t('Fix ime typing issues'), 'fixIMEProblem', {
                    desc: t('This option is recommended when using ime for typing non-latin scripts such as chinese, japanese, or korean and prevents virtual linking from interfering with ime composition at the start of lines.'),
                    visible: adv,
                }),
                toggleDef(t('Avoid linking in current line'), 'excludeLinksInCurrentLine', {
                    desc: t('If activated, there will be no links in the current line.'),
                    visible: adv,
                }),
            ]),

            // ---------- Headers ----------
            groupDef(t('Headers'), [
                toggleDef(t('Include headers'), 'includeHeaders', {
                    desc: t('When enabled, Markdown headings (lines starting with #) will also be included for virtual linking.'),
                }),
                toggleDef(t('Allow virtual links in headers'), 'allowLinksInHeaders', {
                    desc: t('When enabled, virtual links will be displayed inside Markdown headings. Tip: use with Quick Switcher++ for header navigation.'),
                }),
                toggleDef(t('Enable header symbol keywords'), 'headerMatchSymbols', {
                    desc: t('When enabled, text between start and end symbols in headers will be used as virtual link keywords. Tip: use EasyTyping to select text and add symbols.'),
                }),
                actionDef(t('Copy EasyTyping template'), async () => {
                    await navigator.clipboard.writeText('⟦${0:${SEL}}⟧');
                    new Notice(t('EasyTyping template copied to clipboard!'));
                }, { visible: () => s.headerMatchSymbols }),
                textDef(t('Start symbol'), 'headerMatchStartSymbol', {
                    desc: t('Symbol marking the start of the keyword in headers. Must be different from end symbol.'),
                    visible: () => s.headerMatchSymbols,
                }),
                textDef(t('End symbol'), 'headerMatchEndSymbol', {
                    desc: t('Symbol marking the end of the keyword in headers. Must be different from start symbol.'),
                    visible: () => s.headerMatchSymbols,
                }),
                toggleDef(t('Only match headers between symbols'), 'headerMatchOnlyBetweenSymbols', {
                    desc: t('When enabled, only headers containing start and end symbols will produce virtual links. Unmarked headers will not produce virtual links.'),
                    visible: () => s.headerMatchSymbols,
                }),
                toggleDef(t('Auto-insert symbol into headers'), 'headerAutoAppendSuffix', {
                    desc: t('When enabled, a unique symbol is automatically placed at the front of new or modified header text, preventing accidental matching by regular body text.'),
                }),
                textDef(t('Header marker symbol'), 'headerAutoAppendSymbol', {
                    desc: t('The symbol placed at the front of header text (after # but before content). Use a rare character not found in normal text.'),
                    visible: () => s.headerAutoAppendSuffix,
                }),
                numberDef(t('Header jump retry delay (ms)'), 'headerJumpRetryDelay', {
                    desc: t('When you click a virtual link pointing to a heading, the plugin jumps again after a short delay to correct position drift in large files. This is the base delay in milliseconds; it retries 3 times with increasing intervals. Minimum 100.'),
                    min: 100,
                }),
            ]),

            // ---------- Fuzzy matching ----------
            groupDef(t('Fuzzy matching'), [
                toggleDef(t('Fuzzy meaning matching'), 'enableStemming', {
                    desc: t('When enabled, keywords are normalized before matching so related forms link to the same note or heading. English: each word is reduced to its stem and irregular verbs are aligned (e.g. "He ran to the store" matches "he runs to the store"). Chinese: common function words are stripped (e.g. "我的项目计划" matches "项目计划"). Off by default.'),
                }),
                dropdownDef(t('Fuzzy matching language'), 'stemmingLanguage', {
                    'auto': 'Auto (by script)',
                    'en': 'English',
                    'zh': 'Chinese',
                }, {
                    desc: t('Language used for fuzzy matching. "en" = English stemming + irregular verbs; "zh" = Chinese function-word stripping. Choose "auto" to apply both based on each keyword\'s script.'),
                    disabled: () => !s.enableStemming,
                }),
                sliderDef(t('Fuzzy match similarity threshold'), 'fuzzyMatchThreshold', 80, 100, 1, {
                    desc: t('When fuzzy matching is on, a word is linked only if its similarity to a normalized keyword is above this percentage. Range 80%-100%. Higher = stricter (fewer but more accurate links).'),
                    disabled: () => !s.enableStemming,
                }),
                sliderDef(t('Minimum keyword length for fuzzy matching'), 'fuzzyMinLength', 1, 20, 1, {
                    desc: t('Titles or note names whose normalized length is longer than this are processed by fuzzy matching; those of this length or shorter are skipped (exact matching still works). This keeps fuzzy matching focused on long titles/notes, where inflected or fuzzy variants are common, and avoids false links on short words. Default 6 (Chinese: only titles longer than 6 characters). Range 1-20.'),
                    disabled: () => !s.enableStemming,
                }),
            ]),

            // ---------- Case sensitivity ----------
            groupDef(t('Case sensitivity'), [
                toggleDef(t('Case sensitive'), 'matchCaseSensitive', {
                    desc: t('If activated, the matching is case sensitive.'),
                }),
                numberDef(t('Capital letter percentage for automatic match case'), 'capitalLetterProportionForAutomaticMatchCase', {
                    desc: t('The percentage (0 - 100) of capital letters in a file name or alias to be automatically considered as case sensitive.'),
                    min: 0,
                    max: 100,
                    step: 0.1,
                    visible: adv,
                }),
                textDef(t('Tag to ignore case'), 'tagToIgnoreCase', {
                    desc: t('By adding this tag to a file, the linker will ignore the case for the file.'),
                    visible: () => s.advancedSettings && s.matchCaseSensitive,
                }),
                textDef(t('Tag to match case'), 'tagToMatchCase', {
                    desc: t('By adding this tag to a file, the linker will match the case for the file.'),
                    visible: () => s.advancedSettings && !s.matchCaseSensitive,
                }),
                textDef(t('Property name to ignore case'), 'propertyNameToIgnoreCase', {
                    desc: t('By adding this property to a note, containing a list of names, the linker will ignore the case for the specified names / aliases. This way you can decide, which alias should be insensitive.'),
                    visible: adv,
                }),
                textDef(t('Property name to match case'), 'propertyNameToMatchCase', {
                    desc: t('By adding this property to a note, containing a list of names, the linker will match the case for the specified names / aliases. This way you can decide, which alias should be case sensitive.'),
                    visible: adv,
                }),
            ]),

            // ---------- Files ----------
            groupDef(t('Files'), [
                toggleDef(t('Include all files'), 'includeAllFiles', {
                    desc: t('Include all files for the virtual linker.'),
                }),
                textAreaDef(t('Glossary linker directories'), 'linkerDirectories', {
                    desc: t('Directories to include for the virtual linker (separated by new lines).'),
                    placeholder: 'List of directory names (separated by new line)',
                    visible: () => !s.includeAllFiles,
                }),
                textAreaDef(t('Excluded directories'), 'excludedDirectories', {
                    desc: t('Directories from which files are to be excluded for the virtual linker (separated by new lines). Files in these directories will not create any virtual links in other files.'),
                    placeholder: 'List of directory names (separated by new line)',
                    visible: () => s.advancedSettings && s.includeAllFiles,
                }),
                textAreaDef(t('Excluded directories for generating virtual links'), 'excludedDirectoriesForLinking', {
                    desc: t('Directories in which the plugin will not create virtual links (separated by new lines).'),
                    placeholder: 'List of directory names (separated by new line)',
                    visible: adv,
                }),
                textDef(t('Tag to include file'), 'tagToIncludeFile', {
                    desc: t('Tag to explicitly include the file for the linker.'),
                    visible: adv,
                }),
                textDef(t('Tag to ignore file'), 'tagToExcludeFile', {
                    desc: t('Tag to ignore the file for the linker.'),
                    visible: adv,
                }),
                textAreaDef(t('Excluded file extensions'), 'excludedExtensions', {
                    desc: t('File extensions to exclude from virtual linking (one per line or comma separated)'),
                    visible: adv,
                }),
            ]),

            // ---------- Exclusions ----------
            groupDef(t('Exclusions'), [
                textAreaDef(t('Excluded keywords'), 'excludedKeywords', {
                    desc: t('Keywords to exclude from virtual linking (comma separated). Files/aliases or headings matching these keywords will not be linked.'),
                    visible: adv,
                }),
                toggleDef(t('Per-note excluded keywords'), 'perNoteExcludeKeywords', {
                    desc: t('When enabled, the global excluded keywords only apply to notes that opt in via a frontmatter property. When disabled, excluded keywords apply to all notes. Usage: add "fakelink-exclude: true" to a note\'s frontmatter to opt in for that note.'),
                    visible: () => !s.includeAllFiles || s.advancedSettings,
                }),
                textDef(t('Frontmatter exclusion property'), 'frontmatterExcludeProperty', {
                    desc: t('The frontmatter property name to check. Only notes with this property set to true will have the global excluded keywords applied. Default: fakelink-exclude.'),
                    visible: () => s.perNoteExcludeKeywords,
                }),
                toggleDef(t('Enable frontmatter exclude list'), 'enableFrontmatterExcludeList', {
                    desc: t('When enabled, each note can define excluded keywords in its frontmatter. These keywords will not be linked anywhere (added on top of the global excluded keywords). Usage: add "fakelink-exclude-keywords: [keyword1, keyword2]" or "fakelink-exclude-keywords: keyword1, keyword2" to a note\'s frontmatter.'),
                    visible: adv,
                }),
                textDef(t('Frontmatter exclude list property'), 'frontmatterExcludeListProperty', {
                    desc: t('The frontmatter property name for per-note excluded keyword lists. Default: fakelink-exclude-keywords.'),
                    visible: () => s.enableFrontmatterExcludeList,
                }),
                toggleDef(t('Exclude text between symbols'), 'enableSymbolExclusion', {
                    desc: t('When enabled, text between the configured start and end symbols (e.g. { ... }) will not produce virtual links. Separate multiple symbol pairs with commas (e.g. start "{,（" end "},）"). Useful for pandoc citations or other special syntax.'),
                }),
                textDef(t('Start symbol'), 'excludeSymbolStart', {
                    desc: t('Symbol marking the start of the excluded text. Separate multiple symbols with commas (matched positionally with the end symbols). Each must differ from its corresponding end symbol.'),
                    visible: () => s.enableSymbolExclusion,
                }),
                textDef(t('End symbol'), 'excludeSymbolEnd', {
                    desc: t('Symbol marking the end of the excluded text. Separate multiple symbols with commas (matched positionally with the start symbols). Each must differ from its corresponding start symbol.'),
                    visible: () => s.enableSymbolExclusion,
                }),
            ]),

            // ---------- Special syntax ----------
            groupDef(t('Special syntax'), [
                toggleDef(t('Bare internal link syntax'), 'enableInternalLinkSyntax', {
                    desc: t('When enabled, plain text like "note#heading" or "note#^block-id" will be treated as a virtual link to that heading/block, without needing to wrap it in [[ ]] (which would create a real link).'),
                }),
                toggleDef(t('Context-aware header disambiguation'), 'enableContextDisambiguation', {
                    desc: t('When a heading name exists in multiple notes, prefer the note whose file name (or alias) appears closest to the match in the current paragraph. This keeps links pointing to the most relevant note instead of listing all of them.'),
                }),
                toggleDef(t('Skip links with multiple targets (batch convert)'), 'skipMultipleTargets', {
                    desc: t('When using "Convert all virtual links to real links (preview)", virtual links that point to more than one note are skipped so you can convert them one by one manually. When off, they are included but unchecked by default and only the first target is converted.'),
                }),
            ]),

            // ---------- Line jumping ----------
            groupDef(t('Line jumping'), [
                toggleDef(t('Jump to line on adv-uri click'), 'jumpEnabled', {
                    desc: t('When enabled, clicks on obsidian://adv-uri links carrying a line parameter are jumped to directly by FakeLink. The Advanced URI plugin is not required for jumping — but it is recommended if you want an easy way to generate these line-targeting links (its "Copy URI" command).'),
                }),
                numberDef(t('Jump delay (ms)'), 'jumpDelayMs', {
                    desc: t('The maximum time (milliseconds) to wait for the target file to render before positioning the cursor. Small files jump almost immediately; large files wait up to this limit. Default 8000.'),
                    min: 0,
                    max: 60000,
                    visible: () => s.jumpEnabled,
                }),
                toggleDef(t('Open in new tab'), 'jumpOpenInNewTab', {
                    desc: t('When the target file is not already open, open it in a new tab. When off, the current tab is reused.'),
                    visible: () => s.jumpEnabled,
                }),
            ]),

            // ---------- References ----------
            groupDef(t('References'), [
                numberDef(t('Maximum references to show'), 'maxReferenceCount', {
                    desc: t('The maximum number of reference markers [1][2]... shown after a virtual link. When a link has more references, a "..." indicator is shown.'),
                    min: 1,
                    max: 20,
                }),
                numberDef(t('Hide link when references exceed'), 'maxReferencesToHideLink', {
                    desc: t('When the total number of matching files (names + aliases + headers) exceeds this threshold, the virtual link will not be displayed.'),
                    min: 1,
                    max: 50,
                }),
                toggleDef(t('Always show multiple references'), 'alwaysShowMultipleReferences', {
                    desc: t('If toggled, if there are multiple matching notes, all references are shown behind the match. If not toggled, the references are only shown if hovering over the match.'),
                }),
            ]),

            // ---------- Appearance ----------
            groupDef(t('Appearance'), [
                toggleDef(t('Color-only display'), 'colorOnlyDisplay', {
                    desc: t('When enabled, virtual links are shown in a custom text color instead of the default background shadow.'),
                }),
                colorDef(t('Header link color'), 'headerVirtualLinkColor', {
                    desc: t('Color for header virtual links (e.g., #517ea0).'),
                }),
                colorDef(t('Note link color'), 'noteVirtualLinkColor', {
                    desc: t('Color for note and alias virtual links (e.g., #c0392b).'),
                }),
                toggleDef(t('Alternative display style'), 'alternativeDisplayStyle', {
                    desc: t('When enabled, strikethrough is replaced with underline, and %%comments%% are collapsed into small dots that expand on the active line.'),
                }),
                toggleDef(t('Apply default link styling'), 'applyDefaultLinkStyling', {
                    desc: t('If toggled, the default link styling will be applied to virtual links. Furthermore, you can style the links yourself with a CSS-snippet affecting the class `virtual-link`. (Find the CSS snippet directory at Appearance -> CSS Snippets -> Open snippets folder)'),
                }),
                textDef(t('Virtual link suffix'), 'virtualLinkSuffix', {
                    desc: t('The suffix to add to auto generated virtual links.'),
                }),
                textDef(t('Virtual link suffix for aliases'), 'virtualLinkAliasSuffix', {
                    desc: t('The suffix to add to auto generated virtual links for aliases.'),
                }),
                toggleDef(t('Use default link style for conversion'), 'useDefaultLinkStyleForConversion', {
                    desc: t('If toggled, the default link style will be used for the conversion of virtual links to real links.'),
                }),
                toggleDef(t('Use [[wikilinks]]'), 'useWikilinks', {
                    desc: t('If toggled, the virtual links will be created as wikilinks instead of Markdown links.'),
                    visible: () => !s.useDefaultLinkStyleForConversion,
                }),
                dropdownDef(t('Link format'), 'linkFormat', {
                    'shortest': 'Shortest',
                    'relative': 'Relative',
                    'absolute': 'Absolute',
                }, {
                    desc: t('The format of the generated links.'),
                    visible: () => !s.useDefaultLinkStyleForConversion,
                }),
            ]),
        ];
    }
}
