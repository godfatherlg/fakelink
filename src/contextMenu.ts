import { App, Menu, TAbstractFile, TFile, TFolder } from 'obsidian';
import { LinkerMetaInfoFetcher } from '../linker/linkerInfo';
import { clearContextLock } from '../linker/virtualLinkDom';
import { convertVirtualLinkToReal } from '../linker/convertLink';
import { getVirtualLinkRawPath } from '../linker/virtualLinkMatch';
import { LinkerCache } from '../linker/linkerCache';
import { t } from './lang/helpers';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('../main').default;

// The right-click menu built for files, folders and virtual links. It used to
// be a method on the plugin; it now takes the plugin as a parameter.

// The MouseEvent of the right-click that produced the current file-menu.
//
// It used to be captured by registering a { once: true } 'contextmenu' listener
// from inside the file-menu handler. Listeners added while an event is being
// dispatched are NOT invoked for that same event (DOM spec), so that captured
// the NEXT right-click and applied the hover lock to an already-closed Menu;
// and every invocation never followed by another right-click left a listener
// attached for good - one per menu opened.
let lastContextMenuEvent: MouseEvent | null = null;
let lastContextMenuAt = 0;

/** Register the persistent capture listener once, from onload. Obsidian removes
 *  it again when the plugin unloads. */
export function registerContextMenuEventCapture(plugin: LinkerPluginType): void {
    plugin.registerDomEvent(
        document,
        'contextmenu',
        (event: MouseEvent) => { lastContextMenuEvent = event; lastContextMenuAt = Date.now(); },
        true
    );
}

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
        // Runs synchronously with the event captured by the persistent listener
        // above, instead of firing on the next right-click.
        const applyContextLock = (event: MouseEvent | null) => {
            // Access the element that triggered the context menu
            const targetElement = event?.target ?? null;

            if (!targetElement || !(targetElement instanceof HTMLElement)) {
                return;
            }

            // Check if clicked on multiple references indicator
            const isMultipleReferences = targetElement.classList.contains('multiple-files-references') || 
                                        targetElement.closest('.multiple-files-references') !== null;

            const virtualLinkSpan = targetElement.closest('.virtual-link-span') ||
                                     targetElement.closest('.virtual-link');

            // If clicked on multiple references indicator, find the containing virtual link element
            if (isMultipleReferences && virtualLinkSpan) {
                const spanEl = virtualLinkSpan as HTMLElement;
                // Add temporary lock class to prevent collapse
                virtualLinkSpan.classList.add('virtual-link-hover-lock');
                spanEl.dataset.fkContextLock = '1';
            }

            // Unlock when the menu closes - for ANY click inside a virtual link,
            // not only on [1|2|3]. getLinkRootSpan's mousedown adds the lock key
            // on every right-click over a virtual link, and every widget rebuild
            // restores the lock class from that set. Registering the cleanup only
            // for [1|2|3] clicks leaked the key when the user right-clicked the
            // link text itself (the usual case): the same-named links in every
            // note came back locked forever and [1|2|3] stayed expanded - hover
            // could no longer collapse it. The file-menu opens for those clicks
            // too, so menu.onHide is the right place to clear it.
            if (virtualLinkSpan) {
                menu.onHide(() => {
                    const spanEl = virtualLinkSpan as HTMLElement;
                    virtualLinkSpan.classList.remove('virtual-link-hover-lock');
                    delete spanEl.dataset.fkContextLock;
                    // Also remove the key from the right-click lock set: without
                    // this, any same-name link rebuilt later would restore the
                    // lock and [1|2|3] would never collapse.
                    const key = virtualLinkSpan.querySelector('.virtual-link-a')?.getAttribute('origin-text') || '';
                    if (key) clearContextLock(key);
                });
            }

            // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
            // Use closest to find the virtual link element even when clicking on child elements
            const virtualLinkElement = targetElement.closest('.virtual-link-a');
            const isVirtualLink = virtualLinkElement !== null;

            // Use the virtual link element for attribute access if found
            const linkElement = virtualLinkElement || targetElement;

            // (A dead menu item used to be added here - it showed up on every
            // file menu as soon as the captured event was reused for a menu
            // that was not opened by a right-click.) Menu items below read the
            // element's attributes only inside their own onClick handlers.
            // Check, if the element has the "virtual-link" class
            if (isVirtualLink) {
                // Always show "Add to excluded keywords" option for virtual links
                menu.addItem((item) => {
                    // Item to add virtual link text to excluded keywords
                    item.setTitle(t('Add to excluded keywords'))
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
                    item.setTitle(t('Convert to real link'))
                        .setIcon('link')
                        .onClick(() => {
                            // Resolve the link's TARGET. `file` here is the note the
                            // menu was opened on (file-menu's argument), which for an
                            // editor right-click IS the host note - converting with it
                            // produced a self-link pointing at the current note.
                            const anchor = linkElement.matches?.('.virtual-link-a')
                                ? linkElement
                                : linkElement.querySelector('.virtual-link-a');
                            // Read the RAW path from data-href: the href attribute is
                            // percent-encoded by the browser, so resolving from it
                            // failed for paths with spaces/non-ASCII characters and
                            // fell back to `file` - a self-link.
                            const rawHref = getVirtualLinkRawPath(anchor);
                            const target = rawHref
                                ? (app.vault.getAbstractFileByPath(rawHref.split('#')[0]) ?? file)
                                : file;
                            convertVirtualLinkToReal(linkElement, target, app, settings);
                        });
                });
            }
        }

        // Decide from the index's own exclusion rules instead of a
        // re-implemented subset of them. The old conditions disagreed with
        // shouldExcludeFile: with "include all files" enabled, a file inside an
        // excluded directory (already excluded!) was still offered "Exclude
        // this file" - a dead menu item.
        // instanceof narrows the TAbstractFile argument instead of casting it;
        // folders have no frontmatter to tag, so they count as already excluded.
        const excludedByIndex = file instanceof TFile
            ? LinkerCache.getInstance(app, settings).cache.isFileExcluded(file)
            : true;
        if (!excludedByIndex) {
            // Item to exclude a virtual link from the linker
            // This action adds the settings.tagToExcludeFile to the file
            menu.addItem((item) => {
                item.setTitle(t('Exclude this file'))
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
        } else {
            //Item to include a virtual link from the linker
            // This action adds the settings.tagToIncludeFile to the file
            menu.addItem((item) => {
                item.setTitle(t('Include this file'))
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

        // A menu not opened by a right-click (the "..." button, a command) has no
        // event of its own, so anything older than a moment cannot belong to it -
        // reusing it would lock a link the user never right-clicked.
        const freshEvent = Date.now() - lastContextMenuAt < 1500 ? lastContextMenuEvent : null;
        applyContextLock(freshEvent);
    } else {
        // Check if the directory is in the linker directories
        const path = file.path + '/';
        const isInIncludedDir = fetcher.includeDirPattern.test(path);
        const isInExcludedDir = fetcher.excludeDirPattern.test(path);

        // If the directory is in the linker directories, add the option to exclude it
        if ((fetcher.includeAllFiles && !isInExcludedDir) || isInIncludedDir) {
            menu.addItem((item) => {
                item.setTitle(t('Exclude this directory'))
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
                item.setTitle(t('Include this directory'))
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
