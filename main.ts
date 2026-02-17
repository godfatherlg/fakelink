import { App, EditorPosition, MarkdownView, Menu, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';

// Helper function to calculate text similarity (0-1)
function calculateSimilarity(text1: string, text2: string): number {
    if (!text1 || !text2) return 0;
    
    // Remove all spaces for comparison
    const s1 = text1.replace(/\s+/g, '').toLowerCase();
    const s2 = text2.replace(/\s+/g, '').toLowerCase();
    
    if (s1 === s2) return 1;
    
    // If one contains the other, high similarity
    if (s1.includes(s2)) return s2.length / s1.length;
    if (s2.includes(s1)) return s1.length / s2.length;
    
    // Calculate character-level similarity (longest common subsequence ratio)
    const lcs = longestCommonSubsequence(s1, s2);
    return lcs / Math.max(s1.length, s2.length);
}

// Helper function for longest common subsequence length
function longestCommonSubsequence(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    return dp[m][n];
}

// Obsidian 兼容的路径处理函数
function dirname(filePath: string): string {
    const lastSlashIndex = filePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? '' : filePath.substring(0, lastSlashIndex);
}

function basename(filePath: string): string {
    const lastSlashIndex = filePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);
}

function relative(from: string, to: string): string {
    // 简化的相对路径计算，适用于 Obsidian 环境
    if (from === to) return '';
    
    const fromParts = from.split('/').filter(part => part !== '');
    const toParts = to.split('/').filter(part => part !== '');
    
    // 找到公共前缀
    let commonLength = 0;
    while (commonLength < fromParts.length && 
           commonLength < toParts.length && 
           fromParts[commonLength] === toParts[commonLength]) {
        commonLength++;
    }
    
    // 计算需要返回的上级目录数量
    const upLevels = fromParts.length - commonLength;
    const downParts = toParts.slice(commonLength);
    
    // 构造相对路径
    const upPath = upLevels > 0 ? '../'.repeat(upLevels) : './';
    const downPath = downParts.join('/');
    
    return downPath ? upPath + downPath : upPath.slice(0, -1); // 移除末尾的 '/'
}

// Helper function to handle table cell conversion with simplified approach
function handleTableCellConversion(targetElement: HTMLElement, app: App, settings: LinkerPluginSettings, updateManager: ExternalUpdateManager): void {
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
                        
                        // Search for the table row in the document
                        // Instead of comparing row text (which differs due to link expansion),
                        // we search for lines where the cell at cellIndex matches cellText
                        
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
                        
                        let bestMatch = { line: -1, offset: -1, similarity: 0 };
                        
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            
                            // Must be a table row (starts with |)
                            if (!line.trim().startsWith('|')) continue;
                            
                            // Split by | correctly (handle escaped pipes in wiki links)
                            const cells = splitTableRow(line);
                            
                            // cellIndex in DOM corresponds to cells[cellIndex + 1]
                            // because cells[0] is empty (before first |)
                            const mdCellIndex = cellIndex + 1;
                            
                            if (mdCellIndex < cells.length) {
                                const cellContent = cells[mdCellIndex].trim();
                                
                                // Check if originText exists in this cell
                                const cellTextIndex = cellContent.indexOf(originText);
                                
                                if (cellTextIndex !== -1) {
                                    // Check if cellContent matches cellText
                                    const cleanCellContent = cellContent
                                        .replace(/\[\[[^\]]*\|([^\]]*)\]\]/g, '$1')
                                        .replace(/\[\[([^\]]*)\]\]/g, '$1')
                                        .replace(/<br\s*\/?>/gi, ' ')
                                        .replace(/\*\*([^*]*)\*\*/g, '$1')
                                        .replace(/\s+/g, ' ')
                                        .trim();
                                    
                                    const similarity = calculateSimilarity(cleanCellContent, cellText);
                                    
                                    // Keep track of the best match
                                    if (similarity > bestMatch.similarity) {
                                        // Calculate precise offset
                                        let offset = 0;
                                        let pipeCount = 0;
                                        
                                        for (let c = 0; c < line.length; c++) {
                                            const char = line[c];
                                            // Check if this pipe is part of a wiki link
                                            const isInWikiLink = () => {
                                                // Look backwards for [[
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
                                        
                                        bestMatch = {
                                            line: i,
                                            offset: offset + cellTextIndex,
                                            similarity: similarity
                                        };
                                    }
                                }
                            }
                        }
                        
                        if (bestMatch.similarity > 0.5) {
                            targetLine = bestMatch.line;
                            preciseOffset = bestMatch.offset;
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
                setTimeout(() => {
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
                            
                            // Search for the table row in the document
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
                            
                            let bestMatch = { line: -1, offset: -1, similarity: 0 };
                            
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                
                                // Must be a table row (starts with |)
                                if (!line.trim().startsWith('|')) continue;
                                
                                // Split by | correctly (handle escaped pipes in wiki links)
                                const cells = splitTableRow(line);
                                const mdCellIndex = cellIndex + 1;
                                
                                if (mdCellIndex < cells.length) {
                                    const cellContent = cells[mdCellIndex].trim();
                                    const cellTextIndex = cellContent.indexOf(expectedText);
                                    
                                    if (cellTextIndex !== -1) {
                                        // Check similarity with cellText
                                        const cleanCellContent = cellContent
                                            .replace(/\[\[[^\]]*\|([^\]]*)\]\]/g, '$1')
                                            .replace(/\[\[([^\]]*)\]\]/g, '$1')
                                            .replace(/<br\s*\/?>/gi, ' ')
                                            .replace(/\*\*([^*]*)\*\*/g, '$1')
                                            .replace(/\s+/g, ' ')
                                            .trim();
                                        
                                        const similarity = calculateSimilarity(cleanCellContent, cellText);
                                        
                                        if (similarity > bestMatch.similarity) {
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
                                            
                                            bestMatch = {
                                                line: i,
                                                offset: offset + cellTextIndex,
                                                similarity: similarity
                                            };
                                        }
                                    }
                                }
                            }
                            
                            if (bestMatch.similarity > 0.5) {
                                targetLine = bestMatch.line;
                                preciseOffset = bestMatch.offset;
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
    includeHeaders: boolean;
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
    // wordBoundaryRegex: string;
    // conversionFormat
}

const DEFAULT_SETTINGS: LinkerPluginSettings = {
    autoToggleByMode: false,
    advancedSettings: false,
    linkerActivated: true,
    matchAnyPartsOfWords: false,
    matchEndOfWords: true,
    matchBeginningOfWords: true,
    suppressSuffixForSubWords: false,
    includeAllFiles: true,
    linkerDirectories: ['Glossary'],
    excludedDirectories: [],
    excludedDirectoriesForLinking: [],
    virtualLinkSuffix: '🔗',
    virtualLinkAliasSuffix: '🔗',
    excludedExtensions: ['.mp4'],
    useMarkdownLinks: false,
    linkFormat: 'shortest',
    defaultUseMarkdownLinks: false,
    defaultLinkFormat: 'shortest',
    useDefaultLinkStyleForConversion: true,
    applyDefaultLinkStyling: true,
    includeHeaders: true,
    headerMatchOnlyBetweenSymbols: false,
    headerMatchStartSymbol: '',
    headerMatchEndSymbol: '',
    matchCaseSensitive: false,
    capitalLetterProportionForAutomaticMatchCase: 0.75,
    tagToIgnoreCase: 'linker-ignore-case',
    tagToMatchCase: 'linker-match-case',
    propertyNameToMatchCase: 'linker-match-case',
    propertyNameToIgnoreCase: 'linker-ignore-case',
    tagToExcludeFile: 'linker-exclude',
    tagToIncludeFile: 'linker-include',
    excludeLinksToOwnNote: true,
    fixIMEProblem: false,
    excludeLinksInCurrentLine: false,
    onlyLinkOnce: true,
    excludeLinksToRealLinkedFiles: true,
    includeAliases: true,
    alwaysShowMultipleReferences: false,
    excludedKeywords: [],
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

        // Listen for view changes
        this.registerEvent(this.app.workspace.on('layout-change', this.handleLayoutChange.bind(this)));
        this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleLayoutChange.bind(this)));

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
                        if (!(link instanceof HTMLAnchorElement)) return false;
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
                        setTimeout(() => {
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

    private isInTableEnvironment(editor: MarkdownView['editor'], fromOffset: number, toOffset: number): boolean {
        try {
            const fromPos = editor.offsetToPos(fromOffset);
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

    addContextMenuItem(menu: Menu, file: TAbstractFile, source: string) {
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

            function contextMenuHandler(event: MouseEvent) {
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
                        setTimeout(() => {
                            virtualLinkSpan.classList.remove('virtual-link-hover-lock');
                        }, 3000); // Remove after 3 seconds to balance operation time and UI responsiveness
                    }
                }

                // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
                const isVirtualLink = targetElement.classList.contains('virtual-link-a');
                const isInTableCell = targetElement.closest('td, th') !== null;

                const from = parseInt(targetElement.getAttribute('from') || '-1');
                const to = parseInt(targetElement.getAttribute('to') || '-1');

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
                                const text = targetElement.getAttribute('origin-text') || '';
                                if (text) {
                                    const newExcludedKeywords = [...new Set([...settings.excludedKeywords, text])];
                                    await this.updateSettings({ excludedKeywords: newExcludedKeywords }).catch(() => {});
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
                                    handleTableCellConversion(targetElement, app, settings, updateManager);
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
                                    const from = parseInt(targetElement.getAttribute('from') || '-1');
                                    const to = parseInt(targetElement.getAttribute('to') || '-1');

                                    if (from === -1 || to === -1) {
                                        return;
                                    }

                                    // Get the shown text
                                    const text = targetElement.getAttribute('origin-text') || '';
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
                                    const headerId = targetElement.getAttribute('data-heading-id');

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
                document.removeEventListener('contextmenu', contextMenuHandler);
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
                            const frontmatter = fileCache?.frontmatter || {};

                            const tag = settings.tagToExcludeFile;
                            let tags = frontmatter['tags'];

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove include tag if it exists
                                    const includeTag = settings.tagToIncludeFile;
                                    if (frontMatter.tags.has(includeTag)) {
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
                            const frontmatter = fileCache?.frontmatter || {};

                            const tag = settings.tagToIncludeFile;
                            let tags = frontmatter['tags'];

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove exclude tag if it exists
                                    const excludeTag = settings.tagToExcludeFile;
                                    if (frontMatter.tags.has(excludeTag)) {
                                        frontMatter.tags.delete(excludeTag);
                                    }
                                }).catch(() => {});

                                updateManager.update();
                            }
                        });
                });
            }

            // Capture the MouseEvent when the context menu is triggered
            document.addEventListener('contextmenu', contextMenuHandler, { once: true });
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
        const virtualLinks = document.querySelectorAll('.virtual-link, .virtual-link-span, .virtual-link-a');
        virtualLinks.forEach(link => {
            // Get original text: try origin-text attribute first, otherwise use link text content
            const anchor = link.classList.contains('virtual-link-a') ? link : link.querySelector('.virtual-link-a');
            const originalText = anchor?.getAttribute('origin-text') || anchor?.textContent || '';
            if (originalText) {
                // Replace virtual link element with text node
                const textNode = document.createTextNode(originalText);
                link.replaceWith(textNode);
            } else {
                // Delete if no text found
                link.remove();
            }
        });
        
        // Clear possible multiple reference indicators (these don't contain main text, delete directly)
        const multipleRefs = document.querySelectorAll('.multiple-files-references, .multiple-files-indicator');
        multipleRefs.forEach(ref => ref.remove());
    }

    onunload() {
        this.cleanupVirtualLinks();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Load markdown links from obsidian settings
        // At the moment obsidian does not provide a clean way to get the settings through an API
        // So we read the app.json settings file directly
        // We also Cannot use the vault API because it only reads the vault files not the .obsidian folder
        try {
            const fileContent = await this.app.vault.adapter.read(this.app.vault.configDir + '/app.json');
            const appSettings = JSON.parse(fileContent);
            this.settings.defaultUseMarkdownLinks = appSettings.useMarkdownLinks;
            this.settings.defaultLinkFormat = appSettings.newLinkFormat ?? 'shortest';
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
            .setName('Auto-toggle activation status by mode')
            .setDesc('When enabled, the plugin will automatically activate in edit mode if inactive, and automatically deactivate in read mode if active')
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
        new Setting(containerEl).setName('Activate virtual linker').addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.linkerActivated).onChange(async (value) => {
                await this.plugin.updateSettings({ linkerActivated: value });
            })
        );

        // Toggle to show advanced settings
        new Setting(containerEl).setName('Show advanced settings').addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.advancedSettings).onChange(async (value) => {
                await this.plugin.updateSettings({ advancedSettings: value });
                this.display();
            })
        );

        new Setting(containerEl).setName('Matching behavior').setHeading();

        // Toggle to include aliases
        new Setting(containerEl)
            .setName('Include aliases')
            .setDesc('If enabled, the virtual linker will also match file aliases.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeAliases).onChange(async (value) => {
                    await this.plugin.updateSettings({ includeAliases: value });
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Toggle to only link once
            new Setting(containerEl)
                .setName('Only link once')
                .setDesc('When enabled, identical terms in the same note will only be linked once (Wikipedia-style).')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.onlyLinkOnce).onChange(async (value) => {
                        await this.plugin.updateSettings({ onlyLinkOnce: value });
                    })
                );

            // Toggle to exclude links to real linked files
            new Setting(containerEl)
                .setName('Exclude links to real linked files')
                .setDesc('When enabled, terms that are already manually linked in the note will not be auto-linked.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToRealLinkedFiles).onChange(async (value) => {
                        await this.plugin.updateSettings({ excludeLinksToRealLinkedFiles: value });
                    })
                );
        }

        // If headers should be matched or not
        new Setting(containerEl)
            .setName('Include headers')
            .setDesc('When enabled, Markdown headings (lines starting with #) will also be included for virtual linking.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeHeaders).onChange(async (value) => {
                    await this.plugin.updateSettings({ includeHeaders: value });
                })
            );

        // Only match headers between symbols
        new Setting(containerEl)
            .setName('Only match headers between symbols')
            .setDesc('When enabled, only headers containing both start and end symbols will be matched, and only the text between symbols will be used as keyword. Start and end symbols must be different.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.headerMatchOnlyBetweenSymbols).onChange(async (value) => {
                    await this.plugin.updateSettings({ headerMatchOnlyBetweenSymbols: value });
                })
            );

        new Setting(containerEl)
            .setName('Start symbol')
            .setDesc('Symbol marking the start of the keyword in headers (can be empty, emoji allowed). Must be different from end symbol.')
            .addText((text) =>
                text.setValue(this.plugin.settings.headerMatchStartSymbol).onChange(async (value) => {
                    await this.plugin.updateSettings({ headerMatchStartSymbol: value });
                })
            );

        new Setting(containerEl)
            .setName('End symbol')
            .setDesc('Symbol marking the end of the keyword in headers (can be empty, emoji allowed). Must be different from start symbol.')
            .addText((text) =>
                text.setValue(this.plugin.settings.headerMatchEndSymbol).onChange(async (value) => {
                    await this.plugin.updateSettings({ headerMatchEndSymbol: value });
                })
            );

        // Toggle setting to match only whole words or any part of the word
        new Setting(containerEl)
            .setName('Match any part of a word')
            .setDesc('When disabled, only complete word matches are linked. When enabled, any substring match will be linked.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchAnyPartsOfWords).onChange(async (value) => {
                    await this.plugin.updateSettings({ matchAnyPartsOfWords: value });
                    this.display();
                })
            );

        if (!this.plugin.settings.matchAnyPartsOfWords) {
            // Toggle setting to match only beginning of words
            new Setting(containerEl)
                .setName('Match the beginning of words')
                .setDesc('When enabled, word prefixes will be linked even without complete word matches.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchBeginningOfWords).onChange(async (value) => {
                        await this.plugin.updateSettings({ matchBeginningOfWords: value });
                        this.display();
                    })
                );

            // Toggle setting to match only end of words
            new Setting(containerEl)
                .setName('Match the end of words')
                .setDesc('When enabled, word suffixes will be linked even without complete word matches.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchEndOfWords).onChange(async (value) => {
                        await this.plugin.updateSettings({ matchEndOfWords: value });
                        this.display();
                    })
                );
        }

        // Toggle setting to suppress suffix for sub words
        if (this.plugin.settings.matchAnyPartsOfWords || this.plugin.settings.matchBeginningOfWords) {
            new Setting(containerEl)
                .setName('Suppress suffix for sub words')
                .setDesc('When enabled, the link suffix will only be shown for complete word matches, not partial matches.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.suppressSuffixForSubWords).onChange(async (value) => {
                        await this.plugin.updateSettings({ suppressSuffixForSubWords: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line start for fixing IME
            new Setting(containerEl)
                .setName('Fix IME problem')
                .setDesc(
                    'Recommended when using IME (input method editor) for typing non-Latin scripts (like Chinese/Japanese/Korean). Prevents virtual linking from interfering with IME composition at the start of lines.'
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
                .setName('Avoid linking in current line')
                .setDesc('If activated, there will be no links in the current line.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksInCurrentLine).onChange(async (value) => {
                        await this.plugin.updateSettings({ excludeLinksInCurrentLine: value });
                    })
                );

            // Input for setting the word boundary regex
            // new Setting(containerEl)
            // 	.setName('Word boundary regex')
            // 	.setDesc('The regex for the word boundary. This regex is used to find the beginning and end of a word. It is used to find the boundaries of the words to match. Defaults to /[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u to catch most word boundaries.')
            // 	.addText((text) =>
            // 		text
            // 			.setValue(this.plugin.settings.wordBoundaryRegex)
            // 			.onChange(async (value) => {
            // 				try {
            // 					await this.plugin.updateSettings({ wordBoundaryRegex: value });
            // 				} catch (e) {
            // 					console.error('Invalid regex', e);
            // 				}
            // 			})
            // 	);
        }

        new Setting(containerEl).setName('Case sensitivity').setHeading();

        // Toggle setting for case sensitivity
        new Setting(containerEl)
            .setName('Case sensitive')
            .setDesc('If activated, the matching is case sensitive.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchCaseSensitive).onChange(async (value) => {
                    await this.plugin.updateSettings({ matchCaseSensitive: value });
                    this.display();
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Number input setting for capital letter proportion for automatic match case
            new Setting(containerEl)
                .setName('Capital letter percentage for automatic match case')
                .setDesc(
                    'The percentage (0 - 100) of capital letters in a file name or alias to be automatically considered as case sensitive.'
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
                    .setName('Tag to ignore case')
                    .setDesc('By adding this tag to a file, the linker will ignore the case for the file.')
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToIgnoreCase).onChange(async (value) => {
                            await this.plugin.updateSettings({ tagToIgnoreCase: value });
                        })
                    );
            } else {
                // Text setting for tag to match case
                new Setting(containerEl)
                    .setName('Tag to match case')
                    .setDesc('By adding this tag to a file, the linker will match the case for the file.')
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToMatchCase).onChange(async (value) => {
                            await this.plugin.updateSettings({ tagToMatchCase: value });
                        })
                    );
            }

            // Text setting for property name to ignore case
            new Setting(containerEl)
                .setName('Property name to ignore case')
                .setDesc(
                    'By adding this property to a note, containing a list of names, the linker will ignore the case for the specified names / aliases. This way you can decide, which alias should be insensitive.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToIgnoreCase).onChange(async (value) => {
                        await this.plugin.updateSettings({ propertyNameToIgnoreCase: value });
                    })
                );

            // Text setting for property name to match case
            new Setting(containerEl)
                .setName('Property name to match case')
                .setDesc(
                    'By adding this property to a note, containing a list of names, the linker will match the case for the specified names / aliases. This way you can decide, which alias should be case sensitive.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToMatchCase).onChange(async (value) => {
                        await this.plugin.updateSettings({ propertyNameToMatchCase: value });
                    })
                );
        }

        new Setting(containerEl).setName('Matched files').setHeading();

        new Setting(containerEl)
            .setName('Include all files')
            .setDesc('Include all files for the virtual linker.')
            .addToggle((toggle) =>
                toggle
                    // .setValue(true)
                    .setValue(this.plugin.settings.includeAllFiles)
                    .onChange(async (value) => {
                        await this.plugin.updateSettings({ includeAllFiles: value });
                        this.display();
                    })
            );

        if (!this.plugin.settings.includeAllFiles) {
            new Setting(containerEl)
                .setName('Glossary linker directories')
                .setDesc('Directories to include for the virtual linker (separated by new lines).')
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
                    .setName('Excluded directories')
                    .setDesc(
                        'Directories from which files are to be excluded for the virtual linker (separated by new lines). Files in these directories will not create any virtual links in other files.'
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
                .setName('Tag to include file')
                .setDesc('Tag to explicitly include the file for the linker.')
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToIncludeFile).onChange(async (value) => {
                        await this.plugin.updateSettings({ tagToIncludeFile: value });
                    })
                );

            // Text setting for tag to ignore file
            new Setting(containerEl)
                .setName('Tag to ignore file')
                .setDesc('Tag to ignore the file for the linker.')
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToExcludeFile).onChange(async (value) => {
                        await this.plugin.updateSettings({ tagToExcludeFile: value });
                    })
                );

            // Toggle setting to exclude links to the active file
            new Setting(containerEl)
                .setName('Exclude self-links to the current note')
                .setDesc('If toggled, links to the note itself are excluded from the linker. (this might not work in preview windows.)')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToOwnNote).onChange(async (value) => {
                        await this.plugin.updateSettings({ excludeLinksToOwnNote: value });
                    })
                );

            // Setting to exclude directories from the linker to be executed
            new Setting(containerEl)
                .setName('Excluded directories for generating virtual links')
                .setDesc('Directories in which the plugin will not create virtual links (separated by new lines).')
                .addTextArea((text) => {
                    let setValue = '';
                    try {
                        setValue = this.plugin.settings.excludedDirectoriesForLinking.join('\n');
                    } catch (e) {
                        console.warn(e);
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
                .setName('Excluded keywords')
                .setDesc('Keywords to exclude from virtual linking (comma separated). Files/aliases or headings matching these keywords will not be linked.')
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
                .setName('Excluded file extensions')
                .setDesc('File extensions to exclude from virtual linking (one per line or comma separated)')
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

        new Setting(containerEl).setName('Link style').setHeading();

        new Setting(containerEl)
            .setName('Always show multiple references')
            .setDesc('If toggled, if there are multiple matching notes, all references are shown behind the match. If not toggled, the references are only shown if hovering over the match.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.alwaysShowMultipleReferences).onChange(async (value) => {
                    await this.plugin.updateSettings({ alwaysShowMultipleReferences: value });
                })
            );

        new Setting(containerEl)
            .setName('Virtual link suffix')
            .setDesc('The suffix to add to auto generated virtual links.')
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkSuffix).onChange(async (value) => {
                    await this.plugin.updateSettings({ virtualLinkSuffix: value });
                })
            );
        new Setting(containerEl)
            .setName('Virtual link suffix for aliases')
            .setDesc('The suffix to add to auto generated virtual links for aliases.')
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkAliasSuffix).onChange(async (value) => {
                    await this.plugin.updateSettings({ virtualLinkAliasSuffix: value });
                })
            );

        // Toggle setting to apply default link styling
        new Setting(containerEl)
            .setName('Apply default link styling')
            .setDesc(
                'If toggled, the default link styling will be applied to virtual links. Furthermore, you can style the links yourself with a CSS-snippet affecting the class `virtual-link`. (Find the CSS snippet directory at Appearance -> CSS Snippets -> Open snippets folder)'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.applyDefaultLinkStyling).onChange(async (value) => {
                    await this.plugin.updateSettings({ applyDefaultLinkStyling: value });
                })
            );

        // Toggle setting to use default link style for conversion
        new Setting(containerEl)
            .setName('Use default link style for conversion')
            .setDesc('If toggled, the default link style will be used for the conversion of virtual links to real links.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.useDefaultLinkStyleForConversion).onChange(async (value) => {
                    await this.plugin.updateSettings({ useDefaultLinkStyleForConversion: value });
                    this.display();
                })
            );

        if (!this.plugin.settings.useDefaultLinkStyleForConversion) {
            // Toggle setting to use markdown links
            new Setting(containerEl)
                .setName('Use [[Wikilinks]]')
                .setDesc('If toggled, the virtual links will be created as Wikilinks instead of Markdown links.')
                .addToggle((toggle) =>
                    toggle.setValue(!this.plugin.settings.useMarkdownLinks).onChange(async (value) => {
                        await this.plugin.updateSettings({ useMarkdownLinks: !value });
                    })
                );

            // Dropdown setting for link format
            new Setting(containerEl)
                .setName('Link format')
                .setDesc('The format of the generated links.')
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