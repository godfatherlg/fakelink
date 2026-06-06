import { App, EditorPosition, MarkdownView, Menu, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './src/lang/helpers';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';

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
    alwaysShowMultipleReferences: boolean;
    excludedKeywords: string[]; // Keywords to exclude from virtual linking
    headerAutoAppendSuffix: boolean; // Auto-append suffix to new headers
    headerAutoAppendSymbol: string; // Symbol to append to headers
    allowLinksInHeaders: boolean; // Allow virtual links in headers
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
    alwaysShowMultipleReferences: false,
    excludedKeywords: [],
    headerAutoAppendSuffix: true,
    headerAutoAppendSymbol: '☱',
    allowLinksInHeaders: true,
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

    settings: LinkerPluginSettings;
    updateManager = new ExternalUpdateManager();

    async onload() {
        await this.loadSettings();

        // Apply alternative display style body class based on settings
        if (this.settings.alternativeDisplayStyle) {
            activeWindow.document.body.classList.add('virtual-linker-alt-style');
        }

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
            checkCallback: (checking: boolean) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                const editor = view?.editor;

                if (!editor || !editor.somethingSelected()) {
                    return false;
                }

                if (checking) return true;

                // Get the selected text range
                const from = editor.getCursor('from');
                const to = editor.getCursor('to');

                // Get the DOM element containing the selection
                const cmEditor = (editor as unknown as { cm: { dom: { querySelector: (selector: string) => Element | null } } }).cm;
                if (!cmEditor) return false;

                const selectionRange = cmEditor.dom.querySelector('.cm-content');
                if (!selectionRange) return false;

                // Find all virtual links in the selection
                // Find all virtual link elements in the selection
                const virtualLinkElements = Array.from(selectionRange.querySelectorAll('a'));

                const virtualLinks = virtualLinkElements
                    .filter((link): link is HTMLAnchorElement => {
                        if (!(link.instanceOf(HTMLAnchorElement))) return false;
                        return link.classList.contains('virtual-linker-link') ||
                               link.classList.contains('virtual-link-a');
                    })
                    .map(link => ({
                        element: link,
                        from: parseInt(link.getAttribute('from') || '-1'),
                        to: parseInt(link.getAttribute('to') || '-1'),
                        text: link.getAttribute('origin-text') || '',
                        href: link.getAttribute('href') || '',
                        headerId: link.getAttribute('data-heading-id') || ''
                    }))
                    .filter(link => {
                        const linkFrom = editor.offsetToPos(link.from);
                        const linkTo = editor.offsetToPos(link.to);
                        return this.isPosWithinRange(linkFrom, linkTo, from, to);
                    })
                    .sort((a, b) => a.from - b.from);

                if (virtualLinks.length === 0) return false;

                // Process all links in a single operation
                const replacements: {from: number, to: number, text: string}[] = [];

                for (const link of virtualLinks) {
                    // Extract path without anchor
                    const hrefWithoutAnchor = link.href.split('#')[0];
                    const targetFile = this.app.vault.getAbstractFileByPath(hrefWithoutAnchor);
                    if (!(targetFile instanceof TFile)) {
                        continue;
                    }

                    const activeFile = this.app.workspace.getActiveFile();
                    const activeFilePath = activeFile?.path ?? '';

                    let absolutePath = targetFile.path;
                    let relativePath = relative(
                        dirname(activeFilePath),
                        dirname(absolutePath)
                    ) + '/' + basename(absolutePath);
                    relativePath = relativePath.replace(/\\/g, '/');

                    const replacementPath = this.app.metadataCache.fileToLinktext(targetFile, activeFilePath);
                    const lastPart = replacementPath.split('/').pop();
                    if (!lastPart) {
                        continue;
                    }
                    const shortestFile = this.app.metadataCache.getFirstLinkpathDest(lastPart, '');
                    let shortestPath = shortestFile?.path === targetFile.path ? lastPart : absolutePath;

                    // Get headerId from virtual link element
                    const headerId = link.element.getAttribute('data-heading-id');
                    const pathSuffix = headerId ? `#${headerId}` : '';

                    // Remove .md extension if needed and add headerId
                    if (!replacementPath.endsWith('.md')) {
                        if (absolutePath.endsWith('.md')) absolutePath = absolutePath.slice(0, -3);
                        if (shortestPath.endsWith('.md')) shortestPath = shortestPath.slice(0, -3);
                        if (relativePath.endsWith('.md')) relativePath = relativePath.slice(0, -3);
                        
                        // Add headerId to all paths
                        absolutePath += pathSuffix;
                        shortestPath += pathSuffix;
                        relativePath += pathSuffix;
                    }

                    const useMarkdownLinks = this.settings.useDefaultLinkStyleForConversion
                        ? this.settings.defaultUseMarkdownLinks
                        : this.settings.useMarkdownLinks;

                    const linkFormat = this.settings.useDefaultLinkStyleForConversion
                        ? this.settings.defaultLinkFormat
                        : this.settings.linkFormat;

                    let replacement = '';
                    if (replacementPath === link.text && linkFormat === 'shortest') {
                        replacement = `[[${replacementPath}]]`;
                    } else {
                        const path = linkFormat === 'shortest' ? shortestPath :
                                   linkFormat === 'relative' ? relativePath :
                                   absolutePath;

                        if (useMarkdownLinks) {
                            replacement = `[${link.text}](${path})`;
                        } else {
                            // For wiki links in tables, escape pipe characters and use appropriate format
                            const isInTable = this.isInTableEnvironment(editor, link.from, link.to);
                            
                            if (isInTable) {
                                // Escape pipe character in text when in table environment
                                const escapedText = link.text.replace(/[\\|]/g, '\\$&');
                                // In table cells, escape the wiki link separator pipe to prevent table parsing issues
                                replacement = `[[${path}\\|${escapedText}]]`;
                            } else {
                                replacement = `[[${path}|${link.text}]]`;
                            }
                        }
                    }
                    replacements.push({
                        from: link.from,
                        to: link.to,
                        text: replacement
                    });
                }

                // Apply all replacements in reverse order to maintain correct positions
                for (const replacement of replacements.reverse()) {
                    const fromPos = editor.offsetToPos(replacement.from);
                    const toPos = editor.offsetToPos(replacement.to);
                    // Try different approaches for table-safe replacement
                    try {
                        // Method 1: Direct replacement
                        editor.replaceRange(replacement.text, fromPos, toPos);
                        
                        // Wait a bit and check again (to catch async issues)
                        window.setTimeout(() => {
                        }, 100);
                        
                        // If we're in table and verification fails, try alternative approach
                        if (this.isInTableEnvironment(editor, replacement.from, replacement.to)) {
                            const afterReplacement = editor.getRange(fromPos, editor.offsetToPos(replacement.from + replacement.text.length));
                            if (replacement.text !== afterReplacement) {
                                // Delete original content first
                                editor.replaceRange('', fromPos, toPos);
                                
                                // Insert character by character for better table compatibility
                                for (let i = 0; i < replacement.text.length; i++) {
                                    const insertPos = editor.offsetToPos(replacement.from + i);
                                    editor.replaceRange(replacement.text[i], insertPos, insertPos);
                                }
                            }
                        }

                    } catch {
                        // Error during replacement, silently continue
                    }
                }
                return true;
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
                            const frontmatter = fileCache?.frontmatter || {} as Record<string, unknown>;

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
                                    const currentTags = [...frontMatter.tags] as string[];

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
                            const frontmatter = fileCache?.frontmatter || {} as Record<string, unknown>;

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
                                    const currentTags = [...frontMatter.tags] as string[];

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
    async updateSettings(settings: Partial<LinkerPluginSettings> = <Partial<LinkerPluginSettings>>{}) {
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
            const view = leaf.view as MarkdownView;
            if (view.previewMode) {
                view.previewMode.rerender(true);
            }
        });
    }
}

class LinkerSettingTab extends PluginSettingTab {
    constructor(app: App, public plugin: LinkerPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Add auto mode toggle setting item
        new Setting(containerEl)
            .setName(t('Auto-toggle activation status by mode'))
            .setDesc(t('When enabled, the plugin will automatically activate in edit mode if inactive, and automatically deactivate in read mode if active'))
            .addToggle(toggle => 
                toggle
                    .setValue(this.plugin.settings.autoToggleByMode)
                    .onChange(async value => {
                        await this.plugin.updateSettings({ autoToggleByMode: value });
                        // Immediately apply settings changes
                        void this.plugin.handleLayoutChange();
                    })
            );


        // Toggle to activate or deactivate the linker
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

        new Setting(containerEl)
            .setName(t('Activate virtual linker'))
            .setDesc(t('Due to table and canvas rendering issues, to fully enable/disable virtual link rendering, use Quick Add or a third-party plugin to toggle the Fake Link plugin on/off.'))
            .addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.linkerActivated).onChange(async (value) => {
                await this.plugin.updateSettings({ linkerActivated: value });
            })
            )
            .addExtraButton((button) => 
                button.setTooltip(t('Copy Quick Add script'))
                    .setIcon('clipboard-copy')
                    .onClick(async () => {
                        await navigator.clipboard.writeText(quickAddCode);
                        new Notice(t('Quick Add script copied to clipboard!'));
                    })
            );



        new Setting(containerEl).setName(t('Matching behavior')).setHeading();

        // Toggle to include aliases
        new Setting(containerEl)
            .setName(t('Include aliases'))
            .setDesc(t('If enabled, the virtual linker will also match file aliases.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeAliases).onChange(async (value) => {
                    await this.plugin.updateSettings({ includeAliases: value });
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Toggle to only link once
            new Setting(containerEl)
                .setName(t('Only link once'))
                .setDesc(t('When enabled, identical terms in the same note will only be linked once.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.onlyLinkOnce).onChange(async (value) => {
                        await this.plugin.updateSettings({ onlyLinkOnce: value });
                    })
                );

            // Toggle to exclude links to real linked files
            new Setting(containerEl)
                .setName(t('Exclude links to real linked files'))
                .setDesc(t('When enabled, terms that are already manually linked in the note will not be auto-linked.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToRealLinkedFiles).onChange(async (value) => {
                        await this.plugin.updateSettings({ excludeLinksToRealLinkedFiles: value });
                    })
                );
        }

        // If headers should be matched or not
        new Setting(containerEl)
            .setName(t('Include headers'))
            .setDesc(t('When enabled, Markdown headings (lines starting with #) will also be included for virtual linking.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeHeaders).onChange(async (value) => {
                    await this.plugin.updateSettings({ includeHeaders: value });
                })
            );

        // Enable header symbol keywords
        new Setting(containerEl)
            .setName(t('Enable header symbol keywords'))
            .setDesc(t('When enabled, text between start and end symbols in headers will be used as virtual link keywords. Tip: use EasyTyping to select text and add symbols.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.headerMatchSymbols).onChange(async (value) => {
                    await this.plugin.updateSettings({ headerMatchSymbols: value });
                })
            );

        if (this.plugin.settings.headerMatchSymbols) {
            new Setting(containerEl)
                .setName(t('Start symbol'))
                .setDesc(t('Symbol marking the start of the keyword in headers. Must be different from end symbol.'))
                .addText((text) =>
                    text.setValue(this.plugin.settings.headerMatchStartSymbol).onChange(async (value) => {
                        await this.plugin.updateSettings({ headerMatchStartSymbol: value });
                    })
                );

            new Setting(containerEl)
                .setName(t('End symbol'))
                .setDesc(t('Symbol marking the end of the keyword in headers. Must be different from start symbol.'))
                .addText((text) =>
                    text.setValue(this.plugin.settings.headerMatchEndSymbol).onChange(async (value) => {
                        await this.plugin.updateSettings({ headerMatchEndSymbol: value });
                    })
                );

            // Only match headers between symbols
            new Setting(containerEl)
                .setName(t('Only match headers between symbols'))
                .setDesc(t('When enabled, only headers containing start and end symbols will produce virtual links. Unmarked headers will not produce virtual links.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.headerMatchOnlyBetweenSymbols).onChange(async (value) => {
                        await this.plugin.updateSettings({ headerMatchOnlyBetweenSymbols: value });
                    })
                );
        }

        // Toggle to allow virtual links in headers
        new Setting(containerEl)
            .setName(t('Allow virtual links in headers'))
            .setDesc(t('When enabled, virtual links will be displayed inside Markdown headings. Disabled by default to avoid formatting clutter.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.allowLinksInHeaders).onChange(async (value) => {
                    await this.plugin.updateSettings({ allowLinksInHeaders: value });
                })
            );

        // Toggle setting to match only whole words or any part of the word
        new Setting(containerEl)
            .setName(t('Match any part of a word'))
            .setDesc(t('When disabled, only complete word matches are linked. When enabled, any substring match will be linked.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchAnyPartsOfWords).onChange(async (value) => {
                    await this.plugin.updateSettings({ matchAnyPartsOfWords: value });
                })
            );

        if (!this.plugin.settings.matchAnyPartsOfWords) {
            // Toggle setting to match only beginning of words
            new Setting(containerEl)
                .setName(t('Match the beginning of words'))
                .setDesc(t('When enabled, word prefixes will be linked even without complete word matches.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchBeginningOfWords).onChange(async (value) => {
                        await this.plugin.updateSettings({ matchBeginningOfWords: value });
                    })
                );

            // Toggle setting to match only end of words
            new Setting(containerEl)
                .setName(t('Match the end of words'))
                .setDesc(t('When enabled, word suffixes will be linked even without complete word matches.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchEndOfWords).onChange(async (value) => {
                        await this.plugin.updateSettings({ matchEndOfWords: value });
                    })
                );
        }

        // Toggle setting to suppress suffix for sub words
        if (this.plugin.settings.matchAnyPartsOfWords || this.plugin.settings.matchBeginningOfWords) {
            new Setting(containerEl)
                .setName(t('Suppress suffix for sub words'))
                .setDesc(t('When enabled, the link suffix will only be shown for complete word matches, not partial matches.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.suppressSuffixForSubWords).onChange(async (value) => {
                        await this.plugin.updateSettings({ suppressSuffixForSubWords: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line start for fixing IME
            new Setting(containerEl)
                .setName(t('Fix ime typing issues'))
                .setDesc(
                t('This option is recommended when using ime for typing non-latin scripts such as chinese, japanese, or korean and prevents virtual linking from interfering with ime composition at the start of lines.')
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.fixIMEProblem).onChange(async (value) => {
                        await this.plugin.updateSettings({ fixIMEProblem: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line
            new Setting(containerEl)
                .setName(t('Avoid linking in current line'))
                .setDesc(t('If activated, there will be no links in the current line.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksInCurrentLine).onChange(async (value) => {
                        await this.plugin.updateSettings({ excludeLinksInCurrentLine: value });
                    })
                );

            // Input for setting the word boundary regex
            // new Setting(containerEl)
            // 	.setName(t('Word boundary regex'))
            // 	.setDesc(t('The regex for the word boundary. This regex is used to find the beginning and end of a word. It is used to find the boundaries of the words to match. Defaults to /[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u to catch most word boundaries.'))
            // 	.addText((text) =>
            // 		text
            // 			.setValue(this.plugin.settings.wordBoundaryRegex)
            // 			.onChange(async (value) => {
            // 				try {
            // 					await this.plugin.updateSettings({ wordBoundaryRegex: value });
            // 				} catch (e) {
            // 					// Invalid regex
            // 				}
            // 			})
            // 	);
        }

        new Setting(containerEl).setName(t('Case sensitivity')).setHeading();

        // Toggle setting for case sensitivity
        new Setting(containerEl)
            .setName(t('Case sensitive'))
            .setDesc(t('If activated, the matching is case sensitive.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchCaseSensitive).onChange(async (value) => {
                    await this.plugin.updateSettings({ matchCaseSensitive: value });
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Number input setting for capital letter proportion for automatic match case
            new Setting(containerEl)
                .setName(t('Capital letter percentage for automatic match case'))
                .setDesc(
                t('The percentage (0 - 100) of capital letters in a file name or alias to be automatically considered as case sensitive.')
                )
                .addText((text) =>
                    text
                        .setValue((this.plugin.settings.capitalLetterProportionForAutomaticMatchCase * 100).toFixed(1))
                        .onChange(async (value) => {
                            let newValue = parseFloat(value);
                            if (isNaN(newValue)) {
                                newValue = 75;
                            } else if (newValue < 0) {
                                newValue = 0;
                            } else if (newValue > 100) {
                                newValue = 100;
                            }
                            newValue /= 100;
                            await this.plugin.updateSettings({ capitalLetterProportionForAutomaticMatchCase: newValue });
                        })
                );

            if (this.plugin.settings.matchCaseSensitive) {
                // Text setting for tag to ignore case
                new Setting(containerEl)
                    .setName(t('Tag to ignore case'))
                    .setDesc(t('By adding this tag to a file, the linker will ignore the case for the file.'))
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToIgnoreCase).onChange(async (value) => {
                            await this.plugin.updateSettings({ tagToIgnoreCase: value });
                        })
                    );
            } else {
                // Text setting for tag to match case
                new Setting(containerEl)
                    .setName(t('Tag to match case'))
                    .setDesc(t('By adding this tag to a file, the linker will match the case for the file.'))
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToMatchCase).onChange(async (value) => {
                            await this.plugin.updateSettings({ tagToMatchCase: value });
                        })
                    );
            }

            // Text setting for property name to ignore case
            new Setting(containerEl)
                .setName(t('Property name to ignore case'))
                .setDesc(
                t('By adding this property to a note, containing a list of names, the linker will ignore the case for the specified names / aliases. This way you can decide, which alias should be insensitive.')
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToIgnoreCase).onChange(async (value) => {
                        await this.plugin.updateSettings({ propertyNameToIgnoreCase: value });
                    })
                );

            // Text setting for property name to match case
            new Setting(containerEl)
                .setName(t('Property name to match case'))
                .setDesc(
                t('By adding this property to a note, containing a list of names, the linker will match the case for the specified names / aliases. This way you can decide, which alias should be case sensitive.')
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToMatchCase).onChange(async (value) => {
                        await this.plugin.updateSettings({ propertyNameToMatchCase: value });
                    })
                );
        }

        new Setting(containerEl).setName(t('Matched files')).setHeading();

        new Setting(containerEl)
            .setName(t('Include all files'))
            .setDesc(t('Include all files for the virtual linker.'))
            .addToggle((toggle) =>
                toggle
                    // .setValue(true)
                    .setValue(this.plugin.settings.includeAllFiles)
                    .onChange(async (value) => {
                        await this.plugin.updateSettings({ includeAllFiles: value });
                    })
            );

        if (!this.plugin.settings.includeAllFiles) {
            new Setting(containerEl)
                .setName(t('Glossary linker directories'))
                .setDesc(t('Directories to include for the virtual linker (separated by new lines).'))
                    .addTextArea((text) => {
                        let setValue = '';
                        try {
                            setValue = this.plugin.settings.linkerDirectories.join('\n');
                        } catch {
                            // Handle join error
                        }

                    text.setPlaceholder('List of directory names (separated by new line)')
                        .setValue(setValue)
                        .onChange(async (value) => {
                            this.plugin.settings.linkerDirectories = value
                                .split('\n')
                                .map((x) => x.trim())
                                .filter((x) => x.length > 0);
                            await this.plugin.updateSettings();
                        });

                    // Set default size
                    text.inputEl.addClass('linker-settings-text-box');
                });
        } else {
            if (this.plugin.settings.advancedSettings) {
                new Setting(containerEl)
                    .setName(t('Excluded directories'))
                    .setDesc(
                t('Directories from which files are to be excluded for the virtual linker (separated by new lines). Files in these directories will not create any virtual links in other files.')
                    )
                    .addTextArea((text) => {
                        let setValue = '';
                        try {
                            setValue = this.plugin.settings.excludedDirectories.join('\n');
                        } catch {
                            // Handle join error
                        }

                        text.setPlaceholder('List of directory names (separated by new line)')
                            .setValue(setValue)
                            .onChange(async (value) => {
                                this.plugin.settings.excludedDirectories = value
                                    .split('\n')
                                    .map((x) => x.trim())
                                    .filter((x) => x.length > 0);
                                await this.plugin.updateSettings();
                            });

                        // Set default size
                        text.inputEl.addClass('linker-settings-text-box');
                    });
            }
        }

        if (this.plugin.settings.advancedSettings) {
            // Text setting for tag to include file
            new Setting(containerEl)
                .setName(t('Tag to include file'))
                .setDesc(t('Tag to explicitly include the file for the linker.'))
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToIncludeFile).onChange(async (value) => {
                        await this.plugin.updateSettings({ tagToIncludeFile: value });
                    })
                );

            // Text setting for tag to ignore file
            new Setting(containerEl)
                .setName(t('Tag to ignore file'))
                .setDesc(t('Tag to ignore the file for the linker.'))
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToExcludeFile).onChange(async (value) => {
                        await this.plugin.updateSettings({ tagToExcludeFile: value });
                    })
                );

            // Toggle setting to exclude links to the active file
            new Setting(containerEl)
                .setName(t('Exclude self-links to the current note'))
                .setDesc(t('If toggled, links to the note itself are excluded from the linker, but this might not work in reading view.'))
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToOwnNote).onChange(async (value) => {
                        await this.plugin.updateSettings({ excludeLinksToOwnNote: value });
                    })
                );

            // Setting to exclude directories from the linker to be executed
            new Setting(containerEl)
                .setName(t('Excluded directories for generating virtual links'))
                .setDesc(t('Directories in which the plugin will not create virtual links (separated by new lines).'))
                .addTextArea((text) => {
                    let setValue = '';
                    try {
                        setValue = this.plugin.settings.excludedDirectoriesForLinking.join('\n');
                    } catch {
                        // Ignore error
                    }

                    text.setPlaceholder('List of directory names (separated by new line)')
                        .setValue(setValue)
                        .onChange(async (value) => {
                            this.plugin.settings.excludedDirectoriesForLinking = value
                                .split('\n')
                                .map((x) => x.trim())
                                .filter((x) => x.length > 0);
                            await this.plugin.updateSettings();
                        });

                    // Set default size
                    text.inputEl.addClass('linker-settings-text-box');
                });

            // Add setting for excluded keywords
            new Setting(containerEl)
                .setName(t('Excluded keywords'))
                .setDesc(t('Keywords to exclude from virtual linking (comma separated). Files/aliases or headings matching these keywords will not be linked.'))
                .addTextArea(text => {
                    text.setValue(this.plugin.settings.excludedKeywords.join(','))
                        .onChange(async value => {
                            const keywords = value.split(',')
                                .map(x => x.trim())
                                .filter(x => x.length > 0);
                            await this.plugin.updateSettings({ excludedKeywords: keywords });
                        });
                    text.inputEl.addClass('linker-settings-text-box');
                });

            // Add setting for excluded file extensions
            new Setting(containerEl)
                .setName(t('Excluded file extensions'))
                .setDesc(t('File extensions to exclude from virtual linking (one per line or comma separated)'))
                .addTextArea(text => {
                    text.setValue(this.plugin.settings.excludedExtensions.join('\n'))
                        .onChange(async value => {
                            const extensions = value.split(/[\n,]/)
                                .map(x => x.trim())
                                .filter(x => x.length > 0)
                                .map(x => x.startsWith('.') ? x : `.${x}`);
                            await this.plugin.updateSettings({ excludedExtensions: extensions });
                        });
                    text.inputEl.addClass('linker-settings-text-box');
                });
        }

        // Header auto-append suffix
        new Setting(containerEl)
            .setName(t('Auto-insert symbol into headers'))
            .setDesc(t('When enabled, a unique symbol is automatically placed at the front of new or modified header text, preventing accidental matching by regular body text.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.headerAutoAppendSuffix).onChange(async (value) => {
                    await this.plugin.updateSettings({ headerAutoAppendSuffix: value });
                })
            );

        if (this.plugin.settings.headerAutoAppendSuffix) {
            new Setting(containerEl)
                .setName(t('Header marker symbol'))
                .setDesc(t('The symbol placed at the front of header text (after # but before content). Use a rare character not found in normal text.'))
                .addText((text) =>
                    text.setValue(this.plugin.settings.headerAutoAppendSymbol).onChange(async (value) => {
                        await this.plugin.updateSettings({ headerAutoAppendSymbol: value });
                    })
                );
        }

        new Setting(containerEl).setName(t('Link style')).setHeading();

        // Toggle setting for alternative display style (underline + comment folding)
        new Setting(containerEl)
            .setName(t('Alternative display style'))
            .setDesc(t('When enabled, strikethrough is replaced with underline, and %%comments%% are collapsed into small dots that expand on the active line.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.alternativeDisplayStyle).onChange(async (value) => {
                    await this.plugin.updateSettings({ alternativeDisplayStyle: value });
                    const doc = this.containerEl.ownerDocument;
                    if (value) {
                        doc.body.classList.add('virtual-linker-alt-style');
                    } else {
                        doc.body.classList.remove('virtual-linker-alt-style');
                    }
                })
            );

        new Setting(containerEl)
            .setName(t('Always show multiple references'))
            .setDesc(t('If toggled, if there are multiple matching notes, all references are shown behind the match. If not toggled, the references are only shown if hovering over the match.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.alwaysShowMultipleReferences).onChange(async (value) => {
                    await this.plugin.updateSettings({ alwaysShowMultipleReferences: value });
                })
            );

        new Setting(containerEl)
            .setName(t('Virtual link suffix'))
            .setDesc(t('The suffix to add to auto generated virtual links.'))
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkSuffix).onChange(async (value) => {
                    await this.plugin.updateSettings({ virtualLinkSuffix: value });
                })
            );
        new Setting(containerEl)
            .setName(t('Virtual link suffix for aliases'))
            .setDesc(t('The suffix to add to auto generated virtual links for aliases.'))
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkAliasSuffix).onChange(async (value) => {
                    await this.plugin.updateSettings({ virtualLinkAliasSuffix: value });
                })
            );

        // Toggle setting to apply default link styling
        new Setting(containerEl)
            .setName(t('Apply default link styling'))
            .setDesc(
                t('If toggled, the default link styling will be applied to virtual links. Furthermore, you can style the links yourself with a CSS-snippet affecting the class `virtual-link`. (Find the CSS snippet directory at Appearance -> CSS Snippets -> Open snippets folder)')
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.applyDefaultLinkStyling).onChange(async (value) => {
                    await this.plugin.updateSettings({ applyDefaultLinkStyling: value });
                })
            );


        // Toggle setting to use default link style for conversion
        new Setting(containerEl)
            .setName(t('Use default link style for conversion'))
            .setDesc(t('If toggled, the default link style will be used for the conversion of virtual links to real links.'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.useDefaultLinkStyleForConversion).onChange(async (value) => {
                    await this.plugin.updateSettings({ useDefaultLinkStyleForConversion: value });
                })
            );

        if (!this.plugin.settings.useDefaultLinkStyleForConversion) {
            // Toggle setting to use markdown links
            new Setting(containerEl)
                .setName(t('Use [[wikilinks]]'))
                .setDesc(t('If toggled, the virtual links will be created as wikilinks instead of Markdown links.'))
                .addToggle((toggle) =>
                    toggle.setValue(!this.plugin.settings.useMarkdownLinks).onChange(async (value) => {
                        await this.plugin.updateSettings({ useMarkdownLinks: !value });
                    })
                );

            // Dropdown setting for link format
            new Setting(containerEl)
                .setName(t('Link format'))
                .setDesc(t('The format of the generated links.'))
                .addDropdown((dropdown) =>
                    dropdown
                        .addOption('shortest', 'Shortest')
                        .addOption('relative', 'Relative')
                        .addOption('absolute', 'Absolute')
                        .setValue(this.plugin.settings.linkFormat)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({ linkFormat: value as 'shortest' | 'relative' | 'absolute' });
                        })
                );
        }
    }
}