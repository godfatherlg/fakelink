import { App, Menu, TAbstractFile, TFolder } from 'obsidian';
import { LinkerMetaInfoFetcher } from '../linker/linkerInfo';
import { clearContextLock } from '../linker/virtualLinkDom';
import { convertVirtualLinkToReal } from '../linker/convertLink';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('../main').default;

// The right-click menu built for files, folders and virtual links. It used to
// be a method on the plugin; it now takes the plugin as a parameter.

export function addContextMenuItem(plugin: LinkerPluginType, menu: Menu, file: TAbstractFile, _source: string) {

    if (!file) {
        return;
    }

    const app: App = plugin.app;
    const updateManager = plugin.updateManager;
    const settings = plugin.settings;

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
                    const spanEl = virtualLinkSpan as HTMLElement;
                    spanEl.dataset.fkContextLock = '1';

                    // Unlock only when the menu closes: drop the 10s timer (that was
                    // the source of "collapses after 10s") and use menu.onHide - the
                    // list stays expanded while the menu is open, and collapses once
                    // it closes after the user chooses (or presses Esc / clicks
                    // elsewhere).
                    menu.onHide(() => {
                        virtualLinkSpan.classList.remove('virtual-link-hover-lock');
                        delete spanEl.dataset.fkContextLock;
                        // Also remove the key from the right-click lock set:
                        // getLinkRootSpan's mousedown adds it on right-click, and
                        // without removing it here any same-name link rebuilt later
                        // would restore the lock and [1|2|3] would never collapse.
                        const key = virtualLinkSpan.querySelector('.virtual-link-a')?.getAttribute('origin-text') || '';
                        if (key) clearContextLock(key);
                    });
                }
            }

            // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
            // Use closest to find the virtual link element even when clicking on child elements
            const virtualLinkElement = targetElement.closest('.virtual-link-a');
            const isVirtualLink = virtualLinkElement !== null;

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
                                await plugin.updateSettings({ excludedKeywords: newExcludedKeywords });
                                updateManager.update();
                            }
                        });
                });

                // Show intelligent conversion options based on context
                // Regular context - show standard conversion
                menu.addItem((item) => {
                    // Item to convert a virtual link to a real link
                    item.setTitle('Convert to real link')
                        .setIcon('link')
                        .onClick(() => {
                            convertVirtualLinkToReal(linkElement, file, app, settings);
                        });
                });
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
                        await plugin.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs }).catch(() => {});

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
                        await plugin.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs }).catch(() => {});

                        updateManager.update();
                    });
            });
        }
    }
}
