import { App, Editor, EditorPosition, MarkdownView, Menu, Notice, Plugin, PluginSettingTab, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './src/lang/helpers';
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem } from 'obsidian';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';
import { BatchConvertModal, BatchConvertFilesModal } from './src/batchConvert';
import { keepScrolledHeadingAligned, resolveHeadingTarget } from './linker/virtualLinkDom';

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
    headingSymbolWhitelist: string[]; // Symbols stripped from heading keywords
    allowLinksInHeaders: boolean; // Allow virtual links in headers
    colorOnlyDisplay: boolean; // Use color-only display for virtual links
    disableVirtualLinkPreview: boolean; // Do not let virtual links trigger the page preview / Hover Editor popover
    frontmatterExcludeProperty: string; // Frontmatter property for per-note opt-in (boolean)
    perNoteExcludeKeywords: boolean; // When enabled, excludedKeywords only apply to notes with the frontmatter property
    enableFrontmatterExcludeList: boolean; // When enabled, notes can define extra excluded keywords in frontmatter
    frontmatterExcludeListProperty: string; // Frontmatter property for per-note keyword list
    headerVirtualLinkColor: string; // Color for header virtual links
    noteVirtualLinkColor: string; // Color for note/alias virtual links
    fuzzyBaseColor: string; // Base color mixed into fuzzy-match link colors
    fuzzyColorMixRatio: number; // How much base color to mix in (0-100)
    headingAlignWatchSeconds: number; // How many seconds a jumped-to heading keeps being re-aligned
    enableStemming: boolean; // 词义模糊匹配 (fuzzy meaning matching)
    stemmingLanguage: string; // Language for fuzzy matching ('en' | 'zh' | 'auto')
    fuzzyMatchThreshold: number; // Minimum similarity (0-100) for fuzzy matching to create a link (only used when enableStemming is on)
    fuzzyMinLength: number; // Minimum normalized length of a title/note name to be considered for fuzzy matching (shorter ones are skipped)
    fuzzySlidingWindow: boolean; // Fuzzy matching also tries shorter suffixes, so terms embedded in Chinese text can match
    fuzzySlidingWindowMaxOffset: number; // Max chars stripped from the front of a text run by the fuzzy sliding window (lower = faster but misses terms buried behind a long prefix)
    skipMultipleTargets: boolean; // In batch conversion, skip virtual links pointing to multiple notes
    enableSymbolExclusion: boolean; // Exclude text between custom start/end symbols from virtual linking
    excludeSymbolStart: string; // Start symbol marking text to exclude from linking
    excludeSymbolEnd: string; // End symbol marking text to exclude from linking
    enableInternalLinkSyntax: boolean; // Recognize bare internal-link syntax like "a#b", "a#^block" as virtual links
    enableContextDisambiguation: boolean; // Limit a multi-file header match to the file named in the current paragraph
    jumpEnabled: boolean; // Intercept obsidian://adv-uri clicks to jump to a line directly
    lineJumpWaitSeconds: number; // How many seconds to wait for the target file to render before jumping to the line
    jumpOpenInNewTab: boolean; // When the target file is not open, open it in a new tab
    lineLinkSelfHeal: boolean; // Self-heal line links when target line numbers drift
    autoExcludeContainedCopies: boolean; // Auto-exclude a note whose name fully contains another note's name AND shares the same first sentence (e.g. a renamed duplicate)
    filenameAffixExclusions: string[]; // Notes whose file name starts or ends with any of these words/symbols are excluded
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
    headingSymbolWhitelist: [],
    allowLinksInHeaders: false,
    colorOnlyDisplay: true,
    disableVirtualLinkPreview: false,
    frontmatterExcludeProperty: 'fakelink-exclude',
    perNoteExcludeKeywords: false,
    enableFrontmatterExcludeList: false,
    frontmatterExcludeListProperty: 'fakelink-exclude-keywords',
    headerVirtualLinkColor: '#517ea0',
    noteVirtualLinkColor: '#c0392b',
    fuzzyBaseColor: '#8e44ad',
    fuzzyColorMixRatio: 50,
    headingAlignWatchSeconds: 12,
    enableStemming: false,
    stemmingLanguage: 'auto',
    fuzzyMatchThreshold: 80,
    fuzzyMinLength: 6,
    fuzzySlidingWindow: false,
    fuzzySlidingWindowMaxOffset: 10,
    skipMultipleTargets: true,
    enableSymbolExclusion: false,
    excludeSymbolStart: '{',
    excludeSymbolEnd: '}',
    enableInternalLinkSyntax: false,
    enableContextDisambiguation: false,
    jumpEnabled: true,
    lineJumpWaitSeconds: 8,
    jumpOpenInNewTab: true,
    lineLinkSelfHeal: false,
    autoExcludeContainedCopies: false,
    filenameAffixExclusions: [],
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

    // Copy a Markdown link for the current line, e.g.
    //   [33](obsidian://adv-uri?vault=<id>&filepath=<url-encoded path>&line=33&column=1&openmode=true&view-mode=source)
    // The full parameter set matches what Advanced URI generates, while the
    // [line-number](...) wrapper keeps the pasted checklist line clean.
    async copyLineUri(file: TFile, lineZeroBased: number) {
        const line = lineZeroBased + 1;
        // Vault id is not part of the public API; fall back to the vault name
        // if getId is unavailable at runtime.
        const vaultId = (this.app.vault as unknown as { getId?: () => string }).getId?.()
            ?? this.app.vault.getName();
        let uri = `obsidian://adv-uri?vault=${encodeURIComponent(vaultId)}`
            + `&filepath=${encodeURIComponent(file.path)}`
            + `&line=${line}&column=1&openmode=true&view-mode=source`;
        // Self-heal: store the target line text so the jump can find it again
        // later even after edits shift the line numbers.
        if (this.settings.lineLinkSelfHeal) {
            const anchor = await this.getLineAnchor(file, lineZeroBased);
            if (anchor) {
                uri += `&anchor=${encodeURIComponent(anchor)}`;
            }
        }
        try {
            await navigator.clipboard.writeText(`[${line}](${uri})`);
            new Notice(t('Line link copied'));
        } catch {
            new Notice(t('Failed to copy line link'));
        }
    }

    // Read the text of `lineZeroBased` and return a short anchor used to
    // re-locate that line later if the file is edited and line numbers drift.
    private async getLineAnchor(file: TFile, lineZeroBased: number): Promise<string> {
        try {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split('\n');
            const text = (lines[lineZeroBased] ?? '').trim();
            const maxLen = 40;
            return text.length > maxLen ? text.slice(0, maxLen) : text;
        } catch {
            return '';
        }
    }

    // Return the line that currently holds `anchor`. Falls back to the recorded
    // `line` when self-healing is off, no anchor was stored, or the anchor text
    // can no longer be found (the line itself was edited away).
    private async resolveLineByAnchor(file: TFile, line: number, anchor?: string): Promise<number> {
        if (!this.settings.lineLinkSelfHeal || !anchor) return line;
        try {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split('\n');
            const idx = line - 1;
            // Recorded line still holds the text → nothing to fix.
            if (idx >= 0 && idx < lines.length && lines[idx].trim().startsWith(anchor)) {
                return line;
            }
            // Drifted: prefer an exact line-start match, then a looser contains match.
            const exact = lines.findIndex(l => l.trim().startsWith(anchor));
            if (exact >= 0) return exact + 1;
            const loose = lines.findIndex(l => l.trim().includes(anchor));
            if (loose >= 0) return loose + 1;
            return line;
        } catch {
            return line;
        }
    }

    // Wait until the target file's editor has rendered at least `targetLine`
    // lines, polling every 200ms until `timeoutMs` elapses.
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

    // Open the target file only (reuse its tab if already open, otherwise
    // open a new one) and return the leaf. Used both by the jump logic and by
    // the protocol handler when a URI carries no line (the "open file" step of
    // an external handler's two-step sequence), so the file gets opened early
    // and rendered before the line jump arrives.
    private async openFileOnly(file: TFile): Promise<WorkspaceLeaf | null> {
        const existing = this.app.workspace.getLeavesOfType('markdown')
            .find(l => (l.getViewState().state as { file?: string })?.file === file.path);

        let leaf: WorkspaceLeaf;
        if (existing) {
            this.app.workspace.setActiveLeaf(existing, { focus: true });
            leaf = existing;
        } else {
            leaf = this.settings.jumpOpenInNewTab
                ? this.app.workspace.getLeaf(true)
                : this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            // CodeMirror only mounts its real DOM for the active leaf, so make
            // sure the freshly opened leaf is active before scrolling.
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
        }
        return leaf;
    }

    // Open the target file (if needed) and, once rendered, move the cursor to
    // `line` and scroll it into view. `line` is 1-based (adv-uri format).
    async jumpToLine(filepath: string, line: number, anchor?: string) {
        const file = this.app.vault.getAbstractFileByPath(filepath);
        if (!(file instanceof TFile)) return;

        const wasAlreadyOpen = this.app.workspace.getLeavesOfType('markdown')
            .some(l => (l.getViewState().state as { file?: string })?.file === file.path);

        const leaf = await this.openFileOnly(file);
        if (!leaf) return;
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return;

        // Self-heal: correct the line number when the recorded one has drifted.
        const targetLine = await this.resolveLineByAnchor(file, line, anchor);
        await this.waitForEditor(view, targetLine, this.settings.lineJumpWaitSeconds * 1000);

        if (!wasAlreadyOpen) {
            // Freshly opened file: wait a beat for CodeMirror's first layout
            // and any MathJax/images to finish reflowing, otherwise
            // scrollIntoView races the ongoing measurement and triggers the
            // "Measure loop restarted" warning (and a visible stutter).
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
        }

        const safeLine = Math.min(targetLine - 1, Math.max(0, view.editor.lineCount() - 1));
        view.editor.focus();
        view.editor.setCursor({ line: safeLine, ch: 0 });
        // Centering (center=true) cannot scroll to the very first lines of a
        // note - there is not half a viewport of content above them, so CM
        // refuses to move. For those top lines use center=false (scrolls them
        // to the top). For deeper lines use center=true so the target sits in
        // the middle of the screen instead of hugging the bottom edge (which
        // is what center=false's "nearest visible" does for lines below the
        // current viewport).
        const center = safeLine >= 15;
        view.editor.scrollIntoView({ from: { line: safeLine, ch: 0 }, to: { line: safeLine, ch: 0 } }, center);
        // scrollIntoView alone cannot frame a line taller than the viewport (an
        // image embed): center=true slices it and center=false only reveals its
        // lower edge. Top-align such lines instead.
        this.alignTallLine(view, safeLine);
    }

    // A line that renders as a tall block (an image embed, a wide table) cannot be
    // framed by scrollIntoView: its `center` flag only offers "middle of the screen"
    // or "nearest visible", so a line taller than the viewport ends up either
    // bottom-aligned (only its lower edge shows) or sliced in half. When the line is
    // taller than the viewport - or its head ended up above it - align the top edge
    // instead, which is what a jump should show. No-op for ordinary lines.
    //
    // Note: BlockInfo.top is in document coordinates and scroller.scrollTop is a
    // scroll offset; they share the same origin up to CodeMirror's content padding,
    // so the alignment can be off by a few pixels - invisible for "show me the head
    // of this line". Runs twice because images keep reflowing while they load.
    private alignTallLine(view: MarkdownView, line: number, pass = 0) {
        const cmEl = view.contentEl.querySelector('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (!cm) return;                                  // 拿不到视图就保持原行为
        const scroller = cm.scrollDOM;
        try {
            const block = cm.lineBlockAt(cm.state.doc.line(line + 1).from);
            const tooTall = block.height > scroller.clientHeight * 0.8;
            const headHidden = block.top < scroller.scrollTop;
            if (!tooTall && !headHidden) return;           // 普通行：不干预
            scroller.scrollTop = block.top - 16;
        } catch {
            return;
        }
        if (pass < 1) window.setTimeout(() => this.alignTallLine(view, line, pass + 1), 250);
    }

    /**
     * Keep a heading centred in the editor showing it, while the content above
     * finishes laying out.
     *
     * Two things make this reliable where a one-shot scroll is not:
     *   - the loop MEASURES where the line actually is (lineBlockAt) and only
     *     acts on readings that hold still, so a "did it work" is known rather
     *     than assumed - and CodeMirror's estimates for not-yet-rendered regions
     *     are never chased;
     *   - the correction is a plain scrollTop write, NOT cm.dispatch(): a
     *     transaction goes through the view's update cycle and issuing one
     *     mid-measure makes CodeMirror restart its measure loop until it gives
     *     up rendering the document entirely.
     */
    public centerHeadingLine(view: MarkdownView, line: number, maxMs = 10000): void {
        const cmEl = view.contentEl.querySelector('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (cm) this.centerCmLine(cm, line, maxMs);
    }

    /**
     * Centre the line a rendered heading element lives on, using the element's
     * OWN editor. This is what makes a hover popover work: Hover Editor hosts a
     * real view that is not part of the workspace's leaf list, so resolving the
     * view through the workspace fails there - but the element itself still
     * knows its editor (EditorView.findFromDOM) and its own position
     * (posAtDOM), which is exact and needs no metadata lookup at all.
     */
    public centerHeadingElement(el: HTMLElement, maxMs = 8000): boolean {
        const cmEl = el.closest('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (!cm) return false;
        let line: number;
        try {
            line = cm.state.doc.lineAt(cm.posAtDOM(el)).number - 1;
        } catch {
            return false;
        }
        this.centerCmLine(cm, line, maxMs);
        return true;
    }

    private centerCmLine(cm: EditorView, line: number, maxMs: number): void {
        const scroller = cm.scrollDOM;

        const controller = new AbortController();
        const stop = () => controller.abort();
        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: controller.signal });
        window.addEventListener('mousedown', stop, { capture: true, signal: controller.signal });
        window.addEventListener('keydown', stop, { capture: true, signal: controller.signal });

        const startedAt = Date.now();
        let passes = 0;
        let lastCurrent = Number.NaN;
        // Minimal intervention, because the experiment was unambiguous: without
        // this code the editor kept rendering but the heading was pushed out of
        // place, with it the view could stop rendering altogether. So: give the
        // view time to recover from the jump, wait for the page to stop moving,
        // and then write ONCE - never touching the scroll again afterwards.
        const MIN_FIRST_WRITE_MS = 2000;
        // The page can move more than once after the first correction: a PDF
        // embed releases its reserved height seconds later, which shrinks
        // everything above the heading and pushes it off the top. Each write
        // goes through requestMeasure (no transaction), so correcting again is
        // safe - the loop keeps the heading in place until the window ends.
        const MAX_WRITES = 8;

        const tick = () => {
            if (controller.signal.aborted) return;
            if (Date.now() - startedAt > maxMs || passes > 6) return;
            let block;
            try {
                const pos = cm.state.doc.line(line + 1).from;
                block = cm.lineBlockAt(pos);
            } catch {
                return;                                  // the document changed under us
            }
            const target = Math.max(6, Math.round((scroller.clientHeight - block.height) / 2));
            const current = Math.round(block.top - scroller.scrollTop);
            // A tight tolerance, but only readings that HOLD STILL are acted on:
            // while CodeMirror is still measuring a region its line positions
            // are estimates that change from tick to tick (chasing those flung
            // the view thousands of pixels away), whereas a settled reading is
            // exact - and a settled offset of half a heading is exactly what
            // needs correcting. A generous tolerance simply declared that
            // half-heading offset "close enough" and left it alone.
            const tolerance = Math.max(6, Math.round(scroller.clientHeight * 0.04));
            const unreliable = current < -scroller.clientHeight;   // CM6 mid-remit
            const stillLoading = Array.from(scroller.querySelectorAll('img'))
                .some((img) => !img.complete);
            const settled = current === lastCurrent && !stillLoading;
            lastCurrent = current;
            const miss = Math.abs(current - target);
            // Safety valve: a surface that never settles (something animating
            // above) would otherwise never be corrected at all.
            const impatient = Date.now() - startedAt > 4000 && miss > 60;
            const shouldAct = miss > tolerance && (settled || impatient);
            const oldEnough = Date.now() - startedAt >= MIN_FIRST_WRITE_MS;
            if (!unreliable && shouldAct && oldEnough && passes < MAX_WRITES) {
                // requestMeasure is CodeMirror's own hook for adjusting the
                // scroll from inside its measure cycle, and it is the only one
                // that works here:
                //   - a plain scrollTop write is re-applied-over by the view's
                //     next measure (the log showed the same offset again and
                //     again - the write simply did not stick);
                //   - a transaction (dispatch) does stick, but issuing one while
                //     the view is measuring makes it restart its measure loop
                //     until it gives up laying the document out.
                // requestMeasure does neither: it runs in the measure cycle, so
                // the position is applied after the view has decided its own.
                try {
                    cm.requestMeasure({
                        read: (view) => {
                            const block = view.lineBlockAt(view.state.doc.line(line + 1).from);
                            return { top: block.top, height: block.height };
                        },
                        write: (m, view) => {
                            const want = m.top - Math.max(6, Math.round((view.scrollDOM.clientHeight - m.height) / 2));
                            view.scrollDOM.scrollTop = Math.max(0, want);
                        },
                    });
                } catch { return; }
                passes++;
            }
            // Keep watching for the whole window even after the position looks
            // right: CodeMirror can STALL (its measure-restart limit), which
            // makes the page hold still while nothing is rendered - so "it looks
            // settled" is not proof that it is finished, and the position has to
            // be re-checked when rendering resumes.
            window.setTimeout(tick, 700);
        };
        window.setTimeout(tick, 400);
    }

    // Mix two hex colors in sRGB. `t` (0-1) is the weight given to `base`.
    private mixHexColors(base: string, target: string, t: number): string {
        const parse = (hex: string): [number, number, number] | null => {
            const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
            if (!m) return null;
            const n = parseInt(m[1], 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        };
        const a = parse(base);
        const b = parse(target);
        // Fall back to the plain target color when either is not a hex color.
        if (!a || !b) return target;
        const mix = (i: number) => Math.round(a[i] * t + b[i] * (1 - t));
        // (Avoid String#padStart: it needs ES2017, while the project's
        //  tsconfig lib only goes up to ES7.)
        const toHex = (v: number) => ('0' + v.toString(16)).slice(-2);
        return `#${toHex(mix(0))}${toHex(mix(1))}${toHex(mix(2))}`;
    }

    // Fuzzy-match links use the base color mixed into the header / note color,
    // so they read as "same family but fuzzier" instead of an unrelated 4th color.
    applyFuzzyColors() {
        const t = Math.min(100, Math.max(0, this.settings.fuzzyColorMixRatio ?? 50)) / 100;
        const base = this.settings.fuzzyBaseColor;
        activeWindow.document.body.style.setProperty(
            '--virtual-link-fuzzy-header-color',
            this.mixHexColors(base, this.settings.headerVirtualLinkColor, t)
        );
        activeWindow.document.body.style.setProperty(
            '--virtual-link-fuzzy-note-color',
            this.mixHexColors(base, this.settings.noteVirtualLinkColor, t)
        );
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
        // Fuzzy-match links: base color mixed into the header / note color.
        this.applyFuzzyColors();

        // Listen for view changes
        this.registerEvent(this.app.workspace.on('layout-change', () => { void this.handleLayoutChange(); }));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => { void this.handleLayoutChange(); }));

        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
        });

        // When auto-exclude (renamed duplicates) re-indexes asynchronously,
        // refresh the decorations so the newly excluded note stops linking.
        LinkerCache.getInstance(this.app, this.settings).onIndexChanged = () => this.updateManager.update();

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

        // Intercept obsidian://adv-uri link clicks (DOM level) to jump to a
        // line directly. FakeLink does NOT register the protocol handler, so
        // the Advanced URI plugin stays fully functional. This handler only
        // catches links rendered as real <a> elements.
        //
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
            const anchor = p.get('anchor') || undefined;
            evt.preventDefault();
            evt.stopImmediatePropagation();
            void this.jumpToLine(filepath, line, anchor);
        }, true);


        // ------------------------------------------------------------------
        // Persist the measured sizes. Without this every session starts cold:
        // the first render of each note re-reads every image header (Obsidian
        // has no partial-read API, so that is a full file read each) and
        // re-measures every block embed - which is the "takes a while before it
        // settles, previews do not even open" behaviour. With it, the work is
        // done once ever and later sessions (including the very first preview
        // after a restart) hit the cache straight away.
        // ------------------------------------------------------------------
        // Bumped once: every height learned before the measure-after-release fix
        // may be a reservation (a guess) rather than a measurement, so those
        // values are dropped and learned again correctly.
        const CACHE_KEY = '__fakelinkSizeCache2';
        const SIZE_CACHE_LIMIT = 1500;
        let sizeCacheSaveTimer: number | null = null;
        const persistSizeCache = () => {
            if (sizeCacheSaveTimer !== null) window.clearTimeout(sizeCacheSaveTimer);
            sizeCacheSaveTimer = window.setTimeout(() => {
                sizeCacheSaveTimer = null;
                void (async () => {
                    try {
                        const loaded: unknown = await this.loadData();
                        const stored = (loaded ?? {}) as Record<string, unknown>;
                        const capMap = <V>(m: Map<string, V>, n: number): Record<string, V> => {
                            const out: Record<string, V> = {};
                            for (const [k, v] of Array.from(m.entries()).slice(-n)) out[k] = v;
                            return out;
                        };
                        const tailMap = <V>(m: Map<number, V>, n: number): Record<string, V> => {
                            const out: Record<string, V> = {};
                            for (const [k, v] of Array.from(m.entries()).slice(-n)) out[String(k)] = v;
                            return out;
                        };
                        stored[CACHE_KEY] = {
                            images: capMap(this.imageSizes, SIZE_CACHE_LIMIT),
                            pdf: capMap(this.pdfHeights, 300),
                            embeds: capMap(this.embedHeights, 300),
                            widths: tailMap(this.pdfWidthHeights, 50),
                            scales: tailMap(this.pdfScaleSamples, 50),
                        };
                        await this.saveData(stored);
                    } catch { /* cache persistence is best-effort */ }
                })();
            }, 3000);
        };
        void (async () => {
            try {
                const loaded: unknown = await this.loadData();
                const stored = (loaded ?? {}) as Record<string, unknown>;
                const c = stored[CACHE_KEY] as
                    | {
                        images?: Record<string, { w: number; h: number }>;
                        pdf?: Record<string, { w: number; h: number }[]>;
                        embeds?: Record<string, { w: number; h: number }[]>;
                        widths?: Record<string, unknown>;
                        scales?: Record<string, unknown>;
                    }
                    | undefined;
                if (!c) return;
                const asList = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : null);
                const images = c.images ?? {};
                for (const k of Object.keys(images)) {
                    const v = images[k];
                    if (v && v.w > 0) this.imageSizes.set(k, v);
                }
                const pdf = c.pdf ?? {};
                for (const k of Object.keys(pdf)) {
                    const list = asList<{ w: number; h: number }>(pdf[k]);
                    if (list) this.pdfHeights.set(k, list);
                }
                const embeds = c.embeds ?? {};
                for (const k of Object.keys(embeds)) {
                    const list = asList<{ w: number; h: number }>(embeds[k]);
                    if (list) this.embedHeights.set(k, list);
                }
                const scales = c.scales ?? {};
                for (const k of Object.keys(scales)) {
                    const list = asList<{ c: number; h: number }>(scales[k]);
                    if (list) this.pdfScaleSamples.set(Number(k), list);
                }
                const widths = c.widths ?? {};
                for (const k of Object.keys(widths)) {
                    const e = widths[k] as { h?: number; r?: number } | null;
                    // Older cache entries were a bare number (no ratio) - skip
                    // them, since they cannot prove the crop shapes match.
                    if (e && typeof e.h === 'number' && e.h > 0 && typeof e.r === 'number' && e.r > 0) {
                        this.pdfWidthHeights.set(Number(k), { h: e.h, r: e.r });
                    }
                }
            } catch { /* a missing/broken cache is not fatal */ }
        })();

        // PDF++ cropped page embeds are created as an EMPTY box and grow to the
        // real page size seconds later (PDF.js renders them), reflowing every-
        // thing below them. That is why a hover preview loses the heading it
        // just jumped to. Reserve the final size up front, from the rect= in the
        // embed's own src, so the layout never changes in the first place - this
        // fixes hover previews, the reading view and embeds alike.
        const pdfBucket = (w: number): number => (w > 0 ? Math.round(w / 20) * 20 : 0);
        const rememberPdfHeight = (src: string, width: number, height: number) => {
            const bucket = pdfBucket(width);
            if (bucket <= 0) return;
            const list = this.pdfHeights.get(src) ?? [];
            const found = list.find((e) => e.w === bucket);
            if (found) found.h = height; else list.push({ w: bucket, h: height });
            while (list.length > 4) list.shift();
            this.pdfHeights.set(src, list);
            persistSizeCache();
        };
        // The shared-height shortcut is only valid for embeds whose crop has the
        // same SHAPE: the stored crop ratio is compared with the requested one,
        // so a differently cropped PDF in the same article is not handed the
        // wrong height (it falls back to its own ratio instead).
        const rememberPdfFallback = (width: number, height: number, ratio: number) => {
            const bucket = pdfBucket(width);
            if (bucket > 0) this.pdfWidthHeights.set(bucket, { h: height, r: ratio });
        };
        const recallPdfFallback = (width: number, ratio: number): number | null => {
            const bucket = pdfBucket(width);
            if (bucket <= 0) return null;
            const entry = this.pdfWidthHeights.get(bucket);
            if (!entry || !(entry.r > 0) || !(ratio > 0)) return null;
            return Math.abs(entry.r - ratio) / ratio <= 0.06 ? entry.h : null;
        };
        const SCALE_SAMPLES_MAX = 8;
        const rememberPdfSample = (width: number, cropHeightPt: number, renderedHeight: number) => {
            const bucket = pdfBucket(width);
            if (bucket <= 0 || !(cropHeightPt > 0) || !(renderedHeight > 0)) return;
            const list = this.pdfScaleSamples.get(bucket) ?? [];
            list.push({ c: Math.round(cropHeightPt), h: renderedHeight });
            while (list.length > SCALE_SAMPLES_MAX) list.shift();
            this.pdfScaleSamples.set(bucket, list);
            persistSizeCache();
        };
        const learnedPdfScale = (width: number): number | null => {
            const bucket = pdfBucket(width);
            const list = bucket > 0 ? this.pdfScaleSamples.get(bucket) : undefined;
            if (!list || list.length < 2) return null;
            const scales = list.filter((s) => s.c > 0).map((s) => s.h / s.c).sort((a, b) => a - b);
            if (scales.length < 2) return null;
            const median = scales[Math.floor(scales.length / 2)];
            const spread = scales[scales.length - 1] - scales[0];
            // Samples must agree, otherwise the model does not describe how
            // PDF++ renders here and must not be used for predictions.
            return spread <= median * 0.12 ? median : null;
        };
        const predictPdfHeight = (width: number, cropHeightPt: number): number | null => {
            const scale = learnedPdfScale(width);
            if (!scale || !(cropHeightPt > 0)) return null;
            return Math.round(scale * cropHeightPt);
        };
        const recallPdfHeight = (src: string, width: number): number | null => {
            const list = this.pdfHeights.get(src);
            if (!list || list.length === 0) return null;
            const bucket = pdfBucket(width);
            if (bucket <= 0) return list[list.length - 1].h;
            let best = list[0];
            for (const e of list) {
                if (Math.abs(e.w - bucket) < Math.abs(best.w - bucket)) best = e;
            }
            return Math.abs(best.w - bucket) <= 80 ? best.h : null;
        };
        const reserveEmbedHeight = (el: HTMLElement) => {
            if (el.dataset.fkReserved) return;
            const src = el.getAttribute('src') || '';
            const m = /rect=([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)/.exec(src);
            if (!m) return;
            const w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
            const h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
            if (!(w > 0 && h > 0)) return;
            el.dataset.fkReserved = '1';
            const apply = () => {
                if (!el.isConnected) return;
                // Prefer this embed's own measured height, then any PDF measured
                // at the same width (embeds in one article share it), and only
                // fall back to the crop's ratio when nothing has been measured.
                const width = el.getBoundingClientRect().width;
                const cropRatio = w / h;
                const known = recallPdfHeight(src, width)
                    ?? predictPdfHeight(width, h)
                    ?? recallPdfFallback(width, cropRatio);
                if (known) el.setCssStyles({ minHeight: known + 'px' });
                else el.setCssStyles({ aspectRatio: w + ' / ' + h });
            };
            apply();
            window.requestAnimationFrame(apply);
            // Release as soon as the render settles. Keeping the ratio-based guess
            // forever left the box taller than the real crop, which is what pushed
            // adjacent PDF embeds far apart - the guess is only meant to cover the
            // pre-render window.
            const release = () => {
                el.setCssStyles({ aspectRatio: '', minHeight: '' });
                delete el.dataset.fkReserved;
            };
            let timer: number | null = null;
            // Measure ONLY while no reservation is applied. While it is applied the
            // element's height is the reserved guess, so remembering it would store
            // the guess as if it were the rendered height - and every later visit
            // would then reserve that same wrong value and release it again, which
            // is what pushed the content under the embed (a heading right below it)
            // out of place on every single visit.
            const measureReal = () => {
                if (!el.isConnected || el.dataset.fkReserved) return;
                const rect = el.getBoundingClientRect();
                if (rect.height > 0) {
                    rememberPdfHeight(src, rect.width, Math.round(rect.height));
                    rememberPdfFallback(rect.width, Math.round(rect.height), w / h);
                    rememberPdfSample(rect.width, h, Math.round(rect.height));
                }
            };
            const ro = new ResizeObserver(() => {
                if (timer !== null) window.clearTimeout(timer);
                timer = window.setTimeout(() => {
                    timer = null;
                    if (el.dataset.fkReserved) {
                        // Drop the reservation first: the release resizes the box to
                        // its real height, and that resize is what gets measured. If
                        // nothing resized, the reserved height was already correct and
                        // there is nothing new to learn.
                        release();
                        return;
                    }
                    measureReal();
                    ro.disconnect();
                }, 700);
            });
            ro.observe(el);
            // Hard cap in case the element never resizes at all.
            window.setTimeout(release, 6000);
        };
        // One observer serves everything that has to react to inserted nodes.
        // Four separate ones (PDF crops, images, note embeds, hover popovers)
        // would run four callbacks for every DOM change anywhere in the app -
        // the only always-on cost this plugin has - so they share one instead.
        const onInsert: ((node: HTMLElement) => void)[] = [];
        const insertObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (!node.instanceOf(HTMLElement)) continue;
                    for (const handler of onInsert) handler(node);
                }
            }
        });
        this.register(() => insertObserver.disconnect());

        const RESERVE_SEL = '.internal-embed[src*="rect="]';
        onInsert.push((node) => {
            if (node.matches(RESERVE_SEL)) reserveEmbedHeight(node);
            for (const el of Array.from(node.querySelectorAll<HTMLElement>(RESERVE_SEL))) {
                reserveEmbedHeight(el);
            }
        });
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(RESERVE_SEL))) {
            reserveEmbedHeight(el);
        }

        // Image embeds: unlike PDF++ crops there is no rect= to read, so the real
        // dimensions are parsed straight out of the file header (PNG / JPEG /
        // GIF / WebP) and cached per path. Reserving the aspect ratio up front
        // stops an image from reflowing everything below it. The reservation is
        // dropped again as soon as the image has loaded, so a mis-parsed header
        // can never distort anything - the worst case is simply "no help".
        // ------------------------------------------------------------------
        const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

        // EXIF orientation (JPEG APP1). Orientations 5..8 rotate the image when
        // the browser renders it, so the ratio that will actually be shown is the
        // parsed one with its axes swapped.
        const readExifOrientation = (d: DataView, u: Uint8Array, start: number, len: number): number => {
            if (len < 14) return 0;
            if (!(u[start] === 0x45 && u[start + 1] === 0x78 && u[start + 2] === 0x69 && u[start + 3] === 0x66)) return 0;
            const tiff = start + 6;
            const le = u[tiff] === 0x49 && u[tiff + 1] === 0x49;
            const rd16 = (p: number) => (le ? d.getUint16(p, true) : d.getUint16(p, false));
            const rd32 = (p: number) => (le ? d.getUint32(p, true) : d.getUint32(p, false));
            const ifd = tiff + rd32(tiff + 4);
            if (ifd + 2 > start + len) return 0;
            const count = rd16(ifd);
            for (let i = 0; i < count; i++) {
                const e = ifd + 2 + i * 12;
                if (e + 12 > start + len) return 0;
                if (rd16(e) === 0x0112) return rd16(e + 8);
            }
            return 0;
        };

        // SVG: real size from width/height, otherwise the viewBox ratio.
        const parseSvgSize = (text: string): { w: number; h: number } | null => {
            const head = text.slice(0, 4000);
            const attr = (name: string) => {
                const m = new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(head);
                return m ? parseFloat(m[1]) : NaN;
            };
            const w = attr('width');
            const h = attr('height');
            if (w > 0 && h > 0) return { w, h };
            const vb = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(head);
            if (vb) {
                const p = vb[1].trim().split(/[\s,]+/).map(parseFloat);
                if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
            }
            return null;
        };

        const parseImageSize = (buf: ArrayBuffer): { w: number; h: number } | null => {
            if (buf.byteLength < 32) return null;
            const d = new DataView(buf);
            const u = new Uint8Array(buf);
            if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) {           // PNG
                return { w: d.getUint32(16, false), h: d.getUint32(20, false) };
            }
            if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) {                            // GIF
                return { w: d.getUint16(6, true), h: d.getUint16(8, true) };
            }
            if (u[0] === 0xff && u[1] === 0xd8) {                                            // JPEG
                let o = 2;
                let exifOrientation = 0;
                while (o + 9 < buf.byteLength) {
                    if (u[o] !== 0xff) { o++; continue; }
                    const marker = u[o + 1];
                    const len = d.getUint16(o + 2, false);
                    if (len < 2) return null;
                    if (marker === 0xe1) {
                        exifOrientation = readExifOrientation(d, u, o + 4, len - 2);
                    }
                    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                        const w = d.getUint16(o + 7, false);
                        const h = d.getUint16(o + 5, false);
                        return exifOrientation >= 5 ? { w: h, h: w } : { w, h };
                    }
                    o += 2 + len;
                }
                return null;
            }
            if (u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) {         // WebP
                const fourcc = String.fromCharCode(u[12], u[13], u[14], u[15]);
                if (fourcc === 'VP8X') {
                    return {
                        w: (u[24] | (u[25] << 8) | (u[26] << 16)) + 1,
                        h: (u[27] | (u[28] << 8) | (u[29] << 16)) + 1,
                    };
                }
                if (fourcc === 'VP8 ') {
                    return { w: d.getUint16(26, true) & 0x3fff, h: d.getUint16(28, true) & 0x3fff };
                }
            }
            return null;
        };

        const vaultPathOfImage = (img: HTMLImageElement): string | null => {
            // Wiki embeds wrap the img: <span class="internal-embed" src="a.png">
            const wrapper = img.closest('.internal-embed');
            const raw = wrapper?.getAttribute('src') || '';
            if (raw) return raw.split('#')[0].split('|')[0];
            // Markdown embeds render a bare <img src="app://<id>/<vault path>">
            const src = img.getAttribute('src') || '';
            const m = /^app:\/\/[^/]+\/(.+)$/.exec(src);
            if (!m) return null;
            try { return decodeURIComponent(m[1]); } catch { return m[1]; }
        };

        const applyImageSize = (img: HTMLImageElement, dim: { w: number; h: number }) => {
            if (img.dataset.fkSized) return;
            img.dataset.fkSized = '1';
            img.setCssStyles({ aspectRatio: dim.w + ' / ' + dim.h });
            // Hand the element back to its natural ratio once it has loaded.
            img.addEventListener('load', () => { img.setCssStyles({ aspectRatio: '' }); }, { once: true });
        };

        const reserveImage = (img: HTMLImageElement) => {
            if (img.dataset.fkSized) return;
            if (img.complete && img.naturalWidth > 0) return;      // already laid out
            const path = vaultPathOfImage(img);
            if (!path) return;
            const ext = path.split('.').pop()?.toLowerCase() ?? '';
            if (!IMG_EXT.includes(ext)) return;
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return;
            // Keyed by mtime too, so editing/replacing an image re-reads it.
            const key = path + '\u0000' + file.stat.mtime;
            const known = this.imageSizes.get(key);
            if (known) { applyImageSize(img, known); return; }
            const pending = this.imageSizeInflight.get(key);
            if (pending) { void pending.then((dim) => { if (dim) applyImageSize(img, dim); }); return; }
            const read = (ext === 'svg'
                ? this.app.vault.adapter.read(path).then((text) => parseSvgSize(text))
                : this.app.vault.adapter.readBinary(path).then((buf) => parseImageSize(buf)))
                .then((dim) => {
                    if (dim) { this.imageSizes.set(key, dim); persistSizeCache(); }
                    return dim;
                })
                .catch(() => null)
                .then((dim) => { this.imageSizeInflight.delete(key); return dim; });
            this.imageSizeInflight.set(key, read);
            void read.then((dim) => { if (dim) applyImageSize(img, dim); });
        };

        onInsert.push((node) => {
            if (node.instanceOf(HTMLImageElement)) reserveImage(node);
            for (const img of Array.from(node.querySelectorAll('img'))) {
                reserveImage(img);
            }
        });
        for (const img of Array.from(document.querySelectorAll('img'))) {
            reserveImage(img);
        }

        // ------------------------------------------------------------------
        // Markdown embeds (![[note#^block]] and ![[note]]) render EMPTY first and
        // fill in afterwards, so anything below them - e.g. the heading a hover
        // preview just jumped to - gets pushed down by their whole height.
        // Their height cannot be read from the file (it depends on the container
        // width and on the rendering), but it CAN be remembered: measure once,
        // then reserve that height on every later render. The first render of a
        // given block still shifts; everything after it does not.
        // ------------------------------------------------------------------
        const EMBED_SEL = '.internal-embed.markdown-embed';
        // Width matters: the same block is taller in a narrow hover preview than
        // in a wide pane. Heights are therefore stored per width bucket and
        // looked up by NEAREST bucket - an exact key could never work, because
        // right after insertion the element has no width yet (0), while the
        // value was measured later at the real width.
        const WIDTH_BUCKET = 20;
        const bucketOf = (w: number): number => (w > 0 ? Math.round(w / WIDTH_BUCKET) * WIDTH_BUCKET : 0);
        const rememberEmbedHeight = (src: string, width: number, height: number) => {
            const bucket = bucketOf(width);
            if (bucket <= 0) return;
            const list = this.embedHeights.get(src) ?? [];
            const found = list.find((e) => e.w === bucket);
            if (found) found.h = height; else list.push({ w: bucket, h: height });
            while (list.length > 6) list.shift();
            this.embedHeights.set(src, list);
            persistSizeCache();
        };
        const recallEmbedHeight = (src: string, width: number): number | null => {
            const list = this.embedHeights.get(src);
            if (!list || list.length === 0) return null;
            const bucket = bucketOf(width);
            // Width not measured yet: the most recent value is the best guess.
            if (bucket <= 0) return list[list.length - 1].h;
            let best = list[0];
            for (const e of list) {
                if (Math.abs(e.w - bucket) < Math.abs(best.w - bucket)) best = e;
            }
            return Math.abs(best.w - bucket) <= 80 ? best.h : null;
        };
        const reserveEmbed = (el: HTMLElement) => {
            if (el.dataset.fkEmbedSeen) return;
            el.dataset.fkEmbedSeen = '1';
            const src = el.getAttribute('src');
            const apply = () => {
                if (!src || !el.isConnected) return;
                if (el.dataset.fkEmbedReserved) return;
                const known = recallEmbedHeight(src, el.getBoundingClientRect().width);
                if (known && known > 0) {
                    el.setCssStyles({ minHeight: known + 'px' });
                    el.dataset.fkEmbedReserved = '1';
                }
            };
            apply();
            // Try again next frame: at insertion time the width is still 0, so the
            // lookup above can only fall back to the last known value.
            window.requestAnimationFrame(apply);
            // Measure once the height has stopped changing, then hand the size
            // back to the real content so a stale value can never leave a gap.
            let timer: number | null = null;
            let waited = 0;
            const measure = () => {
                timer = null;
                const rect = el.getBoundingClientRect();
                if (!el.isConnected || rect.height <= 0) { ro.disconnect(); return; }
                // Do not trust a measurement taken while the embed is still
                // filling in: blocks with nested content keep growing, and a
                // partial height poisons the cache (the same block was being
                // remembered as 1641px, then 1341px, then 1305px).
                if (!el.classList.contains('is-loaded') && waited < 4000) {
                    waited += 400;
                    timer = window.setTimeout(measure, 400);
                    return;
                }
                // Hand the size back to the real content BEFORE measuring: while a
                // reservation is applied the height we would read is our own
                // reserved value, and remembering that stores a guess as if it had
                // been measured - so every later visit reserves the same wrong
                // value and releases it again, pushing the content below the embed
                // (a heading right under it, for instance) out of place.
                if (el.dataset.fkEmbedReserved) {
                    el.setCssStyles({ minHeight: '' });
                    delete el.dataset.fkEmbedReserved;
                    timer = window.setTimeout(measure, 400);
                    return;
                }
                if (src) rememberEmbedHeight(src, rect.width, Math.round(rect.height));
                ro.disconnect();
            };
            const ro = new ResizeObserver(() => {
                if (timer !== null) window.clearTimeout(timer);
                timer = window.setTimeout(measure, 400);
            });
            ro.observe(el);
        };
        onInsert.push((node) => {
            if (node.matches(EMBED_SEL)) reserveEmbed(node);
            for (const el of Array.from(node.querySelectorAll<HTMLElement>(EMBED_SEL))) {
                reserveEmbed(el);
            }
        });
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(EMBED_SEL))) {
            reserveEmbed(el);
        }


        // The alignment watch window, in ms. The setting is stored in SECONDS -
        // the number the user types IS the number of seconds - so this is the
        // only conversion point in the plugin (no base value, no multiplier).
        const alignWindow = () =>
            Math.max(3000, (this.settings.headingAlignWatchSeconds || 12) * 1000);

        // Inside a CodeMirror editor the view owns the scroll position, so the
        // move is handed to the editor itself - resolved to a line through the
        // metadata cache and then kept centred by MEASURING it (the same
        // treatment as a click on a heading link). Writing scrollTop into a
        // cm-scroller instead gets overwritten by the view's next measurement,
        // which is what left a preview popover showing half a heading.
        const scrollEditor = (el: HTMLElement, headingText: string): boolean => {
            // The element's own editor first: it works for a hover popover,
            // whose view is not in the workspace's leaf list at all.
            if (this.centerHeadingElement(el, 8000)) return true;
            // Otherwise resolve through the workspace + metadata cache.
            const target = resolveHeadingTarget(this.app, el, headingText, null);
            if (!target) return false;
            this.centerHeadingLine(target.view, target.line, 8000);
            return true;
        };

        // Hover previews (Ctrl+hover a virtual link) open a popover that is
        // already scrolled to the link's heading. There is no click and no
        // workspace leaf involved, so nothing about that navigation can be
        // hooked - attach to the POPOVER instead. The alignment then works off
        // the DOM state alone (whichever heading sits at the top), which needs
        // no Obsidian event name and no link parsing, and therefore cannot
        // silently do nothing.
        onInsert.push((node) => {
            const pops = node.matches('.hover-popover')
                ? [node]
                : Array.from(node.querySelectorAll<HTMLElement>('.hover-popover'));
            // No editor handler here on purpose: for a hover popover the
            // direct scroll (below) is the approach that was verified to
            // centre it correctly. Handing it to the editor looked
            // tidier but left the preview showing half a heading.
            for (const pop of pops) keepScrolledHeadingAligned(pop, 'popover', alignWindow());
        });
        // Everything has registered by now, so start watching: starting earlier
        // would run an incomplete handler list for the first insertions.
        insertObserver.observe(document.body, { childList: true, subtree: true });

        // Rendered-DOM clicks (reading view, popovers rendered as HTML) have no
        // widget and therefore no onclick of their own - navigation is done by
        // Obsidian. Watch those surfaces the same way: no href parsing, nothing
        // prevented or stopped, only the alignment afterwards.
        this.registerDomEvent(document, 'click', (evt) => {
            const el = evt.target as HTMLElement | null;
            if (!el || el.closest('.cm-editor')) return;      // editor: the widget owns it
            if (!el.closest('.virtual-link, a.virtual-link-a')) return;
            const scope = el.closest<HTMLElement>('.hover-popover, .workspace-leaf');
            window.setTimeout(() => keepScrolledHeadingAligned(scope, 'dom-click', alignWindow(), scrollEditor), 60);
        }, true);


        // Take over the obsidian://adv-uri protocol so line links (including
        // those fired from an external browser/handler) are jumped by FakeLink.
        // Obsidian allows only ONE handler per protocol action, so we give way
        // when the Advanced URI plugin is enabled (it registers the same
        // action); when AU is disabled, FakeLink owns it and uses
        // scrollIntoView(center=false), which also fixes the "top few lines
        // won't scroll" bug that Advanced URI's centered scroll has.
        window.setTimeout(() => {
            const advancedUriLoaded = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
                .plugins?.plugins?.['obsidian-advanced-uri'] != null;
            if (advancedUriLoaded) {
                console.warn('[fakelink] Advanced URI is enabled - not registering adv-uri protocol to avoid conflict. Disable Advanced URI to let FakeLink handle line jumping.');
                return;
            }
            if (!this.settings.jumpEnabled) return;
            this.registerObsidianProtocolHandler('adv-uri', (data) => {
                if (!this.settings.jumpEnabled) return;
                const d = data as Record<string, string>;
                const filepath = d['filepath'] || '';
                const line = parseInt(d['line'] || '', 10);
                const anchor = d['anchor'] || undefined;
                if (!filepath) return;
                if (!line || line < 1) {
                    // No line: this is the "open the file" step of an external
                    // handler's two-step sequence. Open it now (so it renders
                    // early) and do nothing else.
                    const file = this.app.vault.getAbstractFileByPath(filepath);
                    if (file instanceof TFile) void this.openFileOnly(file);
                    return;
                }
                void this.jumpToLine(filepath, line, anchor);
            });
        }, 500);

        // Right-click context menu: copy an obsidian://adv-uri link pointing at
        // the line where the cursor is. This lets users generate line links
        // without the Advanced URI plugin (whose "Copy URI" this replaces).
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, info) => {
                const file = info.file;
                if (!file) return;
                menu.addItem((item) =>
                    item
                        .setTitle(t('Copy line link (adv-uri)'))
                        .setIcon('link')
                        .onClick(() => this.copyLineUri(file, editor.getCursor().line))
                );
            })
        );

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

    // Reserves the final height of PDF++ cropped page embeds (see onload).
    private pdfReserveObserver: MutationObserver | null = null;
    // Image embeds: reserve their real size before they load, so they stop
    // reflowing everything below them. Dimensions come from the file header and
    // are cached per path, so each image is read at most once.
    private imageReserveObserver: MutationObserver | null = null;
    private imageSizes = new Map<string, { w: number; h: number }>();
    private imageSizeInflight = new Map<string, Promise<{ w: number; h: number } | null>>();
    // Markdown embeds (block references, whole-note embeds): their height cannot
    // be derived from the file - it depends on the container width and on the
    // rendering - but it can be REMEMBERED: measure once, reserve on every later
    // render. Keyed by src + width, since the same block differs per container.
    private pdfHeights = new Map<string, { w: number; h: number }[]>();
    // Last measured PDF embed height per container width. Embeds of one article
    // share the width, and in most vaults they also share the crop shape, so one
    // measurement can reserve all of them - including the ones not seen yet.
    private pdfWidthHeights = new Map<number, { h: number; r: number }>();
    // Learned px-per-point scale per container width: the rendered height is
    // assumed to be scale × cropHeight, which is independent of the crop SHAPE,
    // so it can predict a crop that has never been rendered. Only trusted once
    // at least two samples agree - a full-width render (where height also
    // depends on the crop width) scatters those ratios and disables the model.
    private pdfScaleSamples = new Map<number, { c: number; h: number }[]>();
    private embedReserveObserver: MutationObserver | null = null;
    private embedHeights = new Map<string, { w: number; h: number }[]>();
    onunload() {
        this.pdfReserveObserver?.disconnect();
        this.imageReserveObserver?.disconnect();
        this.embedReserveObserver?.disconnect();
        this.cleanupVirtualLinks();
    }

    async loadSettings() {
        const stored = await this.loadData() as Partial<LinkerPluginSettings>
            & { headerJumpRetryDelay?: number; jumpDelayMs?: number };
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
        // The watch window used to be stored in milliseconds and multiplied by
        // 24; it is now stored directly in seconds. Carry an existing value over
        // so the behaviour of anyone who had tuned it does not change.
        if (stored.headingAlignWatchSeconds == null && typeof stored.headerJumpRetryDelay === 'number') {
            const migrated = Math.round((stored.headerJumpRetryDelay * 24) / 1000);
            this.settings.headingAlignWatchSeconds =
                Math.min(120, Math.max(3, migrated || DEFAULT_SETTINGS.headingAlignWatchSeconds));
        }
        // Same for the line-link wait: it was stored in milliseconds, it is now
        // stored in seconds.
        if (stored.lineJumpWaitSeconds == null && typeof stored.jumpDelayMs === 'number') {
            this.settings.lineJumpWaitSeconds =
                Math.min(60, Math.max(0, Math.round(stored.jumpDelayMs / 1000)));
        }

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

// `id` was added to SettingDefinitionItem in Obsidian 1.14: it gives each setting
// a stable reference and lets same-named sibling settings be told apart. The
// bundled obsidian typings are still on 1.13 (no `id` yet), so the field is added
// here via an intersection type.
// The id is the settings key: it is language-independent, so it stays stable even
// when a setting's display name is translated or later renamed.
type SettingDef = SettingDefinition & { id?: string };

function toggleDef(name: string, key: string, opts: DefOpts = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'toggle', key, disabled: opts.disabled } };
}
function textDef(name: string, key: string, opts: DefOpts & { placeholder?: string } = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'text', key, placeholder: opts.placeholder, disabled: opts.disabled } };
}
function textAreaDef(name: string, key: string, opts: DefOpts & { placeholder?: string } = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'textarea', key, placeholder: opts.placeholder, disabled: opts.disabled } };
}
function dropdownDef(name: string, key: string, options: Record<string, string>, opts: DefOpts = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'dropdown', key, options, disabled: opts.disabled } };
}
function sliderDef(name: string, key: string, min: number, max: number, step: number, opts: DefOpts = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'slider', key, min, max, step, disabled: opts.disabled } };
}
function numberDef(name: string, key: string, opts: DefOpts & { min?: number; max?: number; step?: number; placeholder?: string } = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'number', key, min: opts.min, max: opts.max, step: opts.step, placeholder: opts.placeholder, disabled: opts.disabled } };
}
function colorDef(name: string, key: string, opts: DefOpts = {}): SettingDef {
    return { id: key, name, desc: opts.desc, visible: opts.visible, aliases: opts.aliases, control: { type: 'color', key, disabled: opts.disabled } };
}
// Buttons have no settings key, and their name is translated (so it is not a
// stable id) — leave them without one.
function actionDef(name: string, action: () => void | Promise<void>, opts: DefOpts = {}): SettingDef {
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
            case 'headingSymbolWhitelist':
                return s.headingSymbolWhitelist.join(',');
            case 'excludedExtensions':
                return s.excludedExtensions.join('\n');
            case 'filenameAffixExclusions':
                return s.filenameAffixExclusions.join(',');
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
            case 'headingSymbolWhitelist':
                await this.plugin.updateSettings({
                    headingSymbolWhitelist: (value as string).split(',').map((x) => x.trim()).filter((x) => x.length > 0),
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
            case 'filenameAffixExclusions':
                await this.plugin.updateSettings({
                    filenameAffixExclusions: (value as string)
                        .split(',')
                        .map((x) => x.trim())
                        .filter((x) => x.length > 0),
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
                this.plugin.applyFuzzyColors();
                break;
            case 'noteVirtualLinkColor':
                await this.plugin.updateSettings({ noteVirtualLinkColor: value as string });
                this.applyCssVar('--virtual-link-note-color', value as string);
                this.plugin.applyFuzzyColors();
                break;
            case 'fuzzyBaseColor':
                await this.plugin.updateSettings({ fuzzyBaseColor: value as string });
                this.plugin.applyFuzzyColors();
                break;
            case 'fuzzyColorMixRatio':
                await this.plugin.updateSettings({ fuzzyColorMixRatio: value as number });
                this.plugin.applyFuzzyColors();
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
        if (pm.enabledPlugins.has(id)) {
            await pm.disablePluginAndSave(id);
            new Notice('Fake Link: OFF');
        } else {
            await pm.enablePluginAndSave(id);
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
                toggleDef(t('Auto-insert heading lock symbol'), 'headerAutoAppendSuffix', {
                    desc: t('When enabled, a unique symbol is automatically placed at the front of new or modified header text, preventing accidental matching by regular body text.'),
                }),
                textDef(t('Heading lock symbol'), 'headerAutoAppendSymbol', {
                    desc: t('The symbol placed at the front of header text (after # but before content). Use a rare character not found in normal text.'),
                    visible: () => s.headerAutoAppendSuffix,
                }),
                textAreaDef(t('Heading symbol whitelist'), 'headingSymbolWhitelist', {
                    desc: t('Symbols in headings that are stripped from the virtual-link keyword (comma separated). Use this to decorate headings with markers (e.g. 🔥) without those markers affecting matching.'),
                }),
                numberDef(t('Heading align watch window (seconds)'), 'headingAlignWatchSeconds', {
                    desc: t('How long (in SECONDS) a jumped-to heading keeps being re-aligned. The heading is put back in place the moment the content above it changes height (a PDF or an image finishing, MathJax typesetting) - the watch is event-driven, so nothing polls while the page is quiet. After this many seconds the plugin stops following, so a change minutes later never moves your view. The number you type is the number of seconds (12 = 12 seconds); there is no conversion. Raise it for very slow notes (e.g. 60).'),
                    min: 3,
                    max: 120,
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
                toggleDef(t('Sliding window for fuzzy matching'), 'fuzzySlidingWindow', {
                    desc: t('Also try shorter suffixes of the text run, not just the whole run. Chinese has no spaces, so a term is usually glued to the words before it, and those extra characters drag the similarity below the threshold. Off by default; turn it on if you need terms embedded in Chinese text to match, at the cost of slower scrolling on long lines.'),
                    disabled: () => !s.enableStemming,
                }),
                sliderDef(t('Sliding window max offset'), 'fuzzySlidingWindowMaxOffset', 2, 24, 1, {
                    desc: t('Maximum number of characters stripped from the front of a text run while searching for a fuzzy match. Lower values are faster but may miss a term buried more than this many characters after the last punctuation/space. Default 10.'),
                    disabled: () => !s.enableStemming || !s.fuzzySlidingWindow,
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
                toggleDef(t('Auto-exclude renamed duplicates'), 'autoExcludeContainedCopies', {
                    desc: t('When enabled, if one note\'s file name fully contains another note\'s file name (e.g. "教育教学" and "教育教学附件") and both notes start with the same first sentence, the longer-named note is automatically excluded from virtual linking (treated like a linker-exclude note). This keeps a copied-and-renamed duplicate from producing links. Off by default.'),
                    visible: adv,
                }),
                textAreaDef(t('Exclude by file name prefix/suffix'), 'filenameAffixExclusions', {
                    desc: t('Notes whose file name starts or ends with any of these words or symbols (comma separated) are excluded from virtual linking, like a linker-exclude note.'),
                    placeholder: 'e.g. 副本, 草稿, _',
                    visible: adv,
                }),
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
            ]),

            // ---------- Special syntax ----------
            groupDef(t('Special syntax'), [
                toggleDef(t('Bare internal link syntax'), 'enableInternalLinkSyntax', {
                    desc: t('When enabled, plain text like "note#heading", "note#^block-id", or "note#heading|alias" is treated as a virtual link. Append "|alias" to set a custom display name. Links end at a space or punctuation; letters/digits directly after the alias become part of it, so add a space before them if needed.'),
                }),
                toggleDef(t('Context-aware header disambiguation'), 'enableContextDisambiguation', {
                    desc: t('When a heading name exists in multiple notes, prefer the note whose file name (or alias) appears closest to the match in the current paragraph. This keeps links pointing to the most relevant note instead of listing all of them.'),
                }),
                toggleDef(t('Exclude text between symbols'), 'enableSymbolExclusion', {
                    desc: t('When enabled, text between the configured start and end symbols (e.g. { ... }) will not produce virtual links. Separate multiple symbol pairs with commas (e.g. start "{,（" end "},）"). Useful for pandoc citations or other special syntax.'),
                }),
                textDef(t('Exclusion start symbol'), 'excludeSymbolStart', {
                    desc: t('Symbol marking the start of the excluded text. Separate multiple symbols with commas (matched positionally with the end symbols). Each must differ from its corresponding end symbol.'),
                    visible: () => s.enableSymbolExclusion,
                }),
                textDef(t('Exclusion end symbol'), 'excludeSymbolEnd', {
                    desc: t('Symbol marking the end of the excluded text. Separate multiple symbols with commas (matched positionally with the start symbols). Each must differ from its corresponding start symbol.'),
                    visible: () => s.enableSymbolExclusion,
                }),
            ]),

            // ---------- Line jumping ----------
            groupDef(t('Line jumping'), [
                toggleDef(t('Jump to line on adv-uri click'), 'jumpEnabled', {
                    desc: t('When enabled, FakeLink registers the obsidian://adv-uri protocol and handles line jumping itself, including links fired from external apps (e.g. a browser or a custom obsidianjump:// handler). Obsidian allows only ONE plugin to handle this protocol, so you must NOT enable the Advanced URI plugin at the same time — keep it disabled, otherwise one of the two plugins will fail to load. Generate line links via the right-click menu "Copy line link (adv-uri)".'),
                }),
                toggleDef(t('Self-heal line links'), 'lineLinkSelfHeal', {
                    desc: t('When enabled, copied line links also store the text of the target line. If the note is edited and line numbers drift, the jump re-finds the line by its text instead of landing on the wrong line. Works for both plain and aliased line links. Line links copied before enabling this have no anchor and keep the old behavior.'),
                    visible: () => s.jumpEnabled,
                }),
                numberDef(t('Line jump wait limit (seconds)'), 'lineJumpWaitSeconds', {
                    desc: t('The maximum time (in SECONDS) to wait for the target file to render before positioning the cursor. Small files jump almost immediately; large files wait up to this limit. The number you type is the number of seconds (8 = 8 seconds); 0 means do not wait.'),
                    min: 0,
                    max: 60,
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

            // ---------- Conversion ----------
            groupDef(t('Conversion'), [
                toggleDef(t('Skip links with multiple targets (batch convert)'), 'skipMultipleTargets', {
                    desc: t('When using "Convert all virtual links to real links (preview)", virtual links that point to more than one note are skipped so you can convert them one by one manually. When off, they are included but unchecked by default and only the first target is converted.'),
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

            // ---------- Appearance ----------
            groupDef(t('Appearance'), [
                toggleDef(t('Color-only display'), 'colorOnlyDisplay', {
                    desc: t('When enabled, virtual links are shown in a custom text color instead of the default background shadow.'),
                }),
                toggleDef(t('No hover preview for virtual links'), 'disableVirtualLinkPreview', {
                    desc: t('When enabled, hovering a virtual link no longer opens a page preview / Hover Editor popover. Virtual links are rendered by this plugin rather than written in the note, so the popover can be unwanted while reading; clicking still opens the note. Off by default. Tip: to keep previews but only when you ask for them, turn on "Require Ctrl/Cmd to trigger" in the core Page preview plugin settings instead.'),
                }),
                colorDef(t('Header link color'), 'headerVirtualLinkColor', {
                    desc: t('Color for header virtual links (e.g., #517ea0).'),
                }),
                colorDef(t('Note link color'), 'noteVirtualLinkColor', {
                    desc: t('Color for note and alias virtual links (e.g., #c0392b).'),
                }),
                colorDef(t('Fuzzy link base color'), 'fuzzyBaseColor', {
                    desc: t('Base color for fuzzy (词义模糊) matches. It is mixed with the header / note color, so a fuzzy link looks like a tinted version of its exact-match counterpart.'),
                }),
                sliderDef(t('Fuzzy color mix'), 'fuzzyColorMixRatio', 0, 100, 5, {
                    desc: t('How much of the fuzzy base color is mixed in. 0% = fuzzy links use the normal colors (feature off); 100% = fuzzy links use the base color only; 50% = an even blend, keeping the header/note hue while tinting it.'),
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
            ]),
        ];
    }
}
