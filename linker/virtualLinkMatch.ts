import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { MarkdownView, TFile, getLinkpath } from 'obsidian';
import { MatchType, PrefixTree } from './linkerCache';
import { t } from '../src/lang/helpers';
import {
    attachTableCellContextMenu,
    contextLockedLinks,
    findHeadingElement,
    findScrollableAncestor,
    headingElementByLine,
    hoverUnlockTimers,
    keepScrolledHeadingAligned,
    MULTI_REFERENCE_HOVER_GRACE_MS,
    patchAllEditorsDispatchClamp,
    resolveHeadingTarget,
    setHoveredHeadingId,
} from './virtualLinkDom';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('main').default;

// ---------------------------------------------------------------------------
// Why the elements built here use `activeDocument.createElement` rather than
// Obsidian's `createEl` helper (which `obsidianmd/prefer-create-el` flags):
//
// They are DETACHED on purpose - a virtual-link span is handed to CodeMirror
// after being built (and the numbered [1|2|3] anchors are appended to that
// still-detached span). `createEl` appends the new element to its receiver
// immediately, so it would place the element in the document before CodeMirror
// could; and plugins that replace that helper (Media Extended) make the call
// throw "HierarchyRequestError: Only one element on document allowed".
//
// `activeDocument` rather than `document` for the same reason the rest of the
// plugin uses it: a hover preview can live in a second window, and an element
// forged on the wrong document does not belong to the DOM it is inserted into.
// ---------------------------------------------------------------------------

export class VirtualMatch {
    private fileHeaderIds: Map<string, string> = new Map();

    // 上下文距离：该文件（名或别名）在正文里离本次匹配有多近，越小越近。
    // 只在"上下文感知的标题消歧"开启且算出了距离时才有值，用于在同一档位
    // （例如都是"标题精准"）内部再排序 —— 正文里提得更近的那篇排前面。
    private fileContextDistances: Map<string, number> = new Map();

    setFileContextDistance(path: string, distance: number) {
        this.fileContextDistances.set(path, distance);
    }

    getFileContextDistance(path: string): number | undefined {
        return this.fileContextDistances.get(path);
    }

    // 本文档里"在本次匹配之前"已经被链接过的文件（精准和模糊匹配都算）。
    // 排序时它压过档位：文章里已经指向过某篇笔记，说明它和当前上下文强相关。
    private alreadyLinkedFiles: Set<TFile> | undefined;

    setAlreadyLinkedFiles(files: Set<TFile>) {
        this.alreadyLinkedFiles = files;
    }

    // 正文里是否已经"提到过"这篇笔记：要么前面已经有一条指向它的链接
    // （精准或模糊匹配，模糊那种靠字符串比对是抓不到的），要么它的文件名/
    // 别名在文中出现过（fileContextDistances 由消歧阶段填入）。
    private isMentioned(file: TFile): boolean {
        if (this.alreadyLinkedFiles?.has(file)) return true;
        return this.fileContextDistances.has(file.path);
    }

    constructor(
        public id: number,
        public originText: string,
        public from: number,
        public to: number,
        public files: TFile[],
        public type: MatchType,
        public isSubWord: boolean,
        public settings: LinkerPluginSettings,
        public plugin: LinkerPluginType, // Add plugin parameter
        public headerId?: string,
        public isBoldContext: boolean = false,
        public isItalicContext: boolean = false,
        public isHighlightContext: boolean = false,
        public isTripleStarContext: boolean = false,
        public isStrikethroughContext: boolean = false,
        public isCommentContext: boolean = false,
        public isInHeaderContext: boolean = false,
        public isFuzzy: boolean = false
    ) {
        if (headerId) {
            for (const file of files) {
                this.fileHeaderIds.set(file.path, headerId);
            }
        }
    }

    setFileHeaderId(file: TFile, headerId: string) {
        this.fileHeaderIds.set(file.path, headerId);
    }

    getFileHeaderId(file: TFile): string | undefined {
        return this.fileHeaderIds.get(file.path);
    }

    get isAlias(): boolean {
        return this.type === MatchType.Alias;
    }

    // True when this match has so many targets that NO link is rendered at all
    // (see the "hide link when references exceed" setting). Such a widget is just
    // plain text, so a click should place the caret rather than being swallowed —
    // otherwise that line becomes unclickable, which defeats the threshold.
    get isHiddenByReferenceLimit(): boolean {
        return this.settings.maxReferencesToHideLink > 0
            && this.files.length > this.settings.maxReferencesToHideLink;
    }

    // DOM methods

    /**
     * A compact signature of everything that can change the rendered DOM (or the
     * anchor's click behaviour). VirtualLinkWidget.eq() compares these so that
     * CodeMirror is allowed to reuse an existing widget's DOM.
     *
     * Why this exists: the widget set is rebuilt on every cursor move, scroll and
     * doc change. Without eq(), CodeMirror destroys and recreates every virtual
     * link's DOM each time, which swaps out the very <a> the pointer is resting
     * on. Obsidian's "require Mod key" hover path remembers that element when the
     * hover starts and refuses to show the preview once it is no longer in the
     * document, so pressing Ctrl after any rebuild silently did nothing.
     *
     * Everything that feeds getCompleteLinkElement / getLinkAnchorElement must be
     * listed here — including the render-affecting settings, otherwise changing a
     * setting would keep the stale DOM alive because eq() still reported "equal".
     *
     * Recompute-per-call is deliberate: a match can be mutated after construction
     * (setFileHeaderId(), isFuzzy), and a cached signature would then be stale.
     * Callers that need it cheaper can memoise it per widget instance.
     */
    getLockKey(): string {
        // 只用 originText：cell editor 失焦提交后，虚拟链接从编辑态切回渲染态，
        // from/to 会变（cell 偏移 → text-node 偏移），带偏移的 key 就失效了。
        // 同名链接会被一起锁定，但无害（只是多展开一会儿，菜单关了就恢复）。
        return this.originText;
    }

    renderKey(): string {
        const s = this.settings;

        // Only the file *set* affects the DOM: display order comes from
        // getFileTypeOrder(), so the array's own order is irrelevant. Sort for
        // a stable signature.
        const filePaths = this.files.map((f) => f.path).sort().join('\u0001');
        const headerIds = this.files
            .map((f) => `${f.path}=${this.fileHeaderIds.get(f.path) ?? ''}`)
            .sort()
            .join('\u0001');
        // 上下文距离也影响 [1|2|3] 的排列，必须进签名，否则 eq() 会以为 DOM
        // 还能复用，顺序变了也不重绘。
        const ctxDistances = this.files
            .map((f) => `${f.path}=${this.fileContextDistances.get(f.path) ?? ''}`)
            .sort()
            .join('\u0001');
        // "此前是否已被链接"同样影响 [1|2|3] 的排序，也必须进签名。
        const linkedFlags = this.files
            .map((f) => `${f.path}=${this.alreadyLinkedFiles?.has(f) ? 1 : 0}`)
            .sort()
            .join('\u0001');

        return [
            this.from,
            this.to,
            this.originText,
            this.type,
            this.isSubWord ? 1 : 0,
            this.isFuzzy ? 1 : 0,
            this.headerId ?? '',
            this.isBoldContext ? 1 : 0,
            this.isItalicContext ? 1 : 0,
            this.isHighlightContext ? 1 : 0,
            this.isTripleStarContext ? 1 : 0,
            this.isStrikethroughContext ? 1 : 0,
            this.isCommentContext ? 1 : 0,
            this.isInHeaderContext ? 1 : 0,
            filePaths,
            headerIds,
            ctxDistances,
            linkedFlags,
            // Settings used by the render methods / the anchor's handlers.
            s.maxReferencesToHideLink,        // hides the link entirely
            s.maxReferenceCount,              // truncates the [1|2|3] list
            s.suppressSuffixForSubWords ? 1 : 0,
            s.applyDefaultLinkStyling ? 1 : 0,
            s.disableVirtualLinkPreview ? 1 : 0,  // hover preview on/off
            s.alwaysShowMultipleReferences ? 1 : 0,
            s.virtualLinkSuffix ?? '',
            s.virtualLinkAliasSuffix ?? '',
            s.headingAlignWatchSeconds,            // alignment watch window (seconds)
        ].join('\u0002');
    }

    getCompleteLinkElement(inTableCellEditor = false) {
        // Hide the link entirely when the total number of matches exceeds the
        // configured threshold (too noisy to be useful).
        if (this.settings.maxReferencesToHideLink > 0 && this.files.length > this.settings.maxReferencesToHideLink) {
            const emptySpan = activeDocument.createElement('span');
            emptySpan.textContent = this.originText;
            // The term DID match — there are simply too many targets, so no link is
            // rendered. Keep the line visually quiet (that is the point of the
            // threshold) but explain it on hover, so it does not look like a bug.
            const tip = t('Matched {count} notes, over the hide limit ({limit}) — no virtual link is shown');
            emptySpan.setAttribute('title', tip
                .replace('{count}', String(this.files.length))
                .replace('{limit}', String(this.settings.maxReferencesToHideLink)));
            return emptySpan;
        }

        // 三层排序：
        //   1) 档位：文件名精准 → 文件名包含 → 别名 → 标题原文相等 →
        //      标题去章节号后相等 → 标题仅包含；
        //   2) 上下文距离：正文里提到该笔记名字的位置离匹配点越近越优先；
        //   3) 时间兜底：最后改动时间越新越优先。新建笔记的 mtime 就等于 ctime，
        //      所以"新建的"和"后来改过的"都算新；重命名不更新这两个时间戳，
        //      因此识别不了改名。
        const sortedFiles = [...this.files].sort((a, b) => {
            // 0) 正文里已经提到过（有链接，或名字出现过）→ 压过档位排前面
            const mentionedA = this.isMentioned(a);
            const mentionedB = this.isMentioned(b);
            if (mentionedA !== mentionedB) return mentionedA ? -1 : 1;

            const byType = this.getFileTypeOrder(a) - this.getFileTypeOrder(b);
            if (byType !== 0) return byType;

            const da = this.fileContextDistances.get(a.path);
            const db = this.fileContextDistances.get(b.path);
            if (da !== undefined && db !== undefined) {
                if (da !== db) return da - db;
            } else if (da !== undefined) {
                return -1;
            } else if (db !== undefined) {
                return 1;
            }

            return (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0);
        });

        // Limit visible files, and show a "..." indicator when there are more
        // references than the configured display limit (instead of silently
        // truncating, which made users think only N references existed).
        let visibleFiles = sortedFiles;
        let hasMore = false;
        if (this.settings.maxReferenceCount > 0 && sortedFiles.length > this.settings.maxReferenceCount) {
            visibleFiles = sortedFiles.slice(0, this.settings.maxReferenceCount);
            hasMore = true;
        }

        const span = this.getLinkRootSpan(inTableCellEditor);
        const firstFile = visibleFiles.length > 0 ? visibleFiles[0] : undefined;
        const firstPath = firstFile ? getLinkpath(firstFile.path) : "";
        span.appendChild(this.getLinkAnchorElement(this.originText, firstPath, firstFile));
        if (visibleFiles.length > 1) {
            if (!this.isSubWord) {
                span.appendChild(this.getMultipleReferencesIndicatorSpan());
            }
            span.appendChild(this.getMultipleReferencesSpan(visibleFiles, hasMore ? sortedFiles.length - visibleFiles.length : 0));
        } else if (hasMore) {
            span.appendChild(this.getOverflowIndicatorSpan(sortedFiles.length - visibleFiles.length));
        }

        if (!this.isSubWord || !this.settings.suppressSuffixForSubWords) {
            const icon = this.getIconSpan();
            if (icon) span.appendChild(icon);
        }
        return span;
    }

    // 多指向链接（[1|2|3]）里各目标文件的排列顺序，越精准越靠前：
    //   0 文件名与关键词精准相同   ┐ 文章匹配
    //   1 文件名包含关键词         ┘
    //   2 别名匹配
    //   3 标题本身就是关键词（"# 牙痛"）        ┐
    //   4 标题去掉章节号后才是关键词（"（六）牙痛"）│ 标题匹配
    //   5 标题只是包含关键词                     ┘
    // 三个要点：
    //   - 必须先看"文件名是否匹配"，再看"有没有标题 id"。原来的写法先判
    //     fileHeaderIds.has()，于是一个文件名正好等于关键词、同时又带标题匹配的
    //     文件会被当成 Header 排到最后。
    //   - 标题匹配内部要按"接近原文的程度"分档：原文相等 > 去章节号后相等 >
    //     只是包含。原来全都归成一个值，同分后只能沿用索引里的原始顺序，
    //     于是"（六）牙痛"可能排在"牙痛"前面。
    //   - 比较前要剥掉标题外面包的标记符号（起始/结束符号）：索引里的关键词不带
    //     符号，标题原文带，不剥会把精准命中误判成"只是包含"。
    private getFileTypeOrder(file: TFile): number {
        const key = this.originText.toLowerCase();
        const base = file.basename.toLowerCase();
        if (base === key) return 0;                 // 文件名精准
        if (base.includes(key)) return 1;           // 文件名包含

        const headerId = this.fileHeaderIds.get(file.path);
        if (headerId) {
            // 剥掉标题外层的标记符号后再比较。
            let hk = headerId.trim();
            const ss = this.settings.headerMatchStartSymbol;
            const es = this.settings.headerMatchEndSymbol;
            if (ss && es && hk.startsWith(ss) && hk.endsWith(es)) {
                const inner = hk.slice(ss.length, hk.length - es.length).trim();
                if (inner) hk = inner;
            }
            hk = hk.toLowerCase();

            // 标题本身就等于关键词（"# 牙痛"）→ 最精准。
            if (hk === key) return 3;
            // 去掉章节号前缀后才等于关键词（"（六）牙痛"）→ 次之。
            if (PrefixTree.stripHeadingNumber(hk).trim().toLowerCase() === key) return 4;
            // 标题只是包含关键词 → 最后。
            return 5;
        }
        return 2;                                   // 别名
    }



    getLinkAnchorElement(linkText: string, href: string, file?: TFile) {
        const link = activeDocument.createElement('a');

        let headerIdToUse: string | undefined;
        if (file) {
            headerIdToUse = this.getFileHeaderId(file);
        } else if (this.files.length > 0) {
            headerIdToUse = this.getFileHeaderId(this.files[0]) || this.headerId;
        } else {
            headerIdToUse = this.headerId;
        }

        let fullPath = href;
        if (headerIdToUse) {
            link.href = `${href}#${headerIdToUse}`;
            link.setAttribute('data-heading-id', headerIdToUse);
            fullPath = `${href}#${headerIdToUse}`;
        } else {
            link.href = href;
        }
        link.textContent = linkText;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('from', this.from.toString());
        link.setAttribute('to', this.to.toString());
        link.setAttribute('origin-text', this.originText);
        // `internal-link` is the signal Obsidian's Page preview (and therefore
        // Hover Editor) uses to open a hover popover. A virtual link is drawn by
        // this plugin rather than written in the note, so that popover is not
        // always wanted - when it is switched off the class is simply left out.
        // Styling comes from the plugin's own classes (.virtual-link-span a /
        // .virtual-link-a) and clicking is handled by this widget, so nothing
        // else depends on it.
        link.classList.add('virtual-link-a');
        if (!this.settings.disableVirtualLinkPreview) {
            link.classList.add('internal-link');
        }

        // Show which note this link opens, so the numbered candidates of a
        // multi-file heading match ([1|2|3]) can be told apart before clicking.
        // Obsidian's own hover preview shows the same heading content for every
        // candidate, so it cannot distinguish them - a title tooltip can.
        const titleFile = file || (this.files.length > 0 ? this.files[0] : undefined);
        if (titleFile) {
            link.title = t('Open note: {name}').replace('{name}', titleFile.basename);
        }

        link.onclick = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const targetFile = file || (this.files.length > 0 ? this.files[0] : null);
            if (!targetFile) return false;

            // 点进单元格（cell editor 激活）时，直接导航会触发 cell editor 的焦点
            // 恢复（setCellFocus）报错（Selection points outside of document）。
            // 先 blur 掉 cell editor，延迟到它提交退出后再导航。
            const active = activeDocument.activeElement as HTMLElement | null;
            const inCellEditor = Boolean(active && active.closest('.table-cell-wrapper'));

            const doNav = () => {
                if (this.plugin && this.plugin.app) {
                // The surface the click happened in: a hover popover hosts its
                // own editor (Hover Editor), i.e. it is NOT a workspace leaf,
                // while openLinkText() can only ever scroll a workspace leaf -
                // which is why the retries below cannot fix a popover.
                const clicked = event.target as HTMLElement | null;
                const scope = (clicked?.closest?.('.hover-popover') as HTMLElement | null)
                    ?? (clicked?.closest?.('.workspace-leaf') as HTMLElement | null);

                // 跳转前给所有编辑器装上 dispatch 保护：大表格 / PDF-heavy note
                // 里，跳转后的滚动与重新渲染会让 Obsidian 拿超界 selection 去
                // dispatch，抛 "Selection points outside of document"（这是
                // Obsidian 内部算错的位置，插件改不了源头，只能在这里拦住并
                // clamp 到合法范围重试）。
                patchAllEditorsDispatchClamp();

                void this.plugin.app.workspace.openLinkText(fullPath, '', false, { active: true });

                // Align the surface that was actually navigated, until its
                // layout settles: a heading jump is only exact at the instant
                // it happens, and content above the heading keeps changing
                // height afterwards. The heading is detected from the DOM
                // (whichever one sits at the top), so this still works when the
                // link's #fragment cannot be read back. The watch window comes
                // from the existing "Header jump retry delay" setting
                // (12 seconds by default), so slow notes can be given more time.
                if (headerIdToUse) {
                    const alignWindow = Math.max(3000, (this.settings.headingAlignWatchSeconds || 12) * 1000);
                    // Skip a re-navigation when the heading is already framed:
                    // each one is a full jump+re-render, so there is no reason to
                    // pay for it (or to disturb the view) when nothing is wrong.
                    const alreadyFramed = (): boolean => {
                        const el = findHeadingElement(document.body, headerIdToUse);
                        if (!el) return false;
                        const sc = findScrollableAncestor(el);
                        if (!sc) return false;
                        const r = el.getBoundingClientRect();
                        const sr = sc.getBoundingClientRect();
                        return r.top >= sr.top - 4 && r.bottom <= sr.bottom + 4;
                    };
                    if (clicked?.closest?.('.cm-editor')) {
                        // Clicking landed inside a CodeMirror editor. Do NOT
                        // scroll it ourselves: every synthetic scroll tried here
                        // (plain scrollTop, then requestMeasure, then dispatch)
                        // ended with CodeMirror restarting its measure loop until
                        // it stopped rendering this PDF-heavy note - and the
                        // positions it produced were wrong anyway, because the
                        // line positions it reports for unrendered regions are
                        // estimates.
                        //
                        // Re-issue the navigation instead, late: Obsidian scrolls
                        // the heading into view with its own machinery, so no
                        // synthetic scroll is involved at all. The drift this
                        // corrects (a PDF embed releasing its reserved height,
                        // pushing the heading out of view) happens seconds after
                        // the jump, so the re-navigation is simply repeated late.
                        // Re-navigation alone is not enough: it only fires while the
                        // heading is NOT visible, and it stops after 8 seconds - so a
                        // heading that a slowly rendering image pushed DOWN (still
                        // visible, just in the wrong place) was never corrected, and
                        // nothing checked at all after the last re-navigation.
                        //
                        // The measured alignment is therefore run here as well, for
                        // the whole watch window (the "Heading align watch window"
                        // setting), and it moves the view through the editor's own
                        // API - never through a synthetic scroll, which is what made
                        // CodeMirror give up rendering a PDF-heavy note.
                        // Set once the running alignment actually reaches the
                        // heading. The late re-navigation below must not fire
                        // then: it is a full jump + re-render that lands on
                        // Obsidian's own position, which is exactly the "it
                        // centres and then gets pulled back" symptom.
                        let alignmentWorking = false;
                        let targetViewport: number | undefined;
                        const editorScroll = (el: HTMLElement, headingText: string): boolean => {
                            alignmentWorking = true;
                            if (this.plugin?.centerHeadingElement?.(el, alignWindow, targetViewport)) return true;
                            const target = resolveHeadingTarget(this.plugin.app, el, headingText, null);
                            if (!target) return false;
                            this.plugin.centerHeadingLine(target.view, target.line, alignWindow, targetViewport);
                            return true;
                        };
                        // A real [[link]] lands centred and stays there, so the
                        // whole correction pass is opt-in (see the
                        // "Align heading after jump" setting).
                        if (this.settings.alignHeadingAfterJump) {
                            keepScrolledHeadingAligned(
                                scope, 'click-editor', alignWindow, editorScroll, headerIdToUse,
                                (o) => { targetViewport = o; },
                                // openLinkText lands on the ROW, not necessarily
                                // centred (a real link's internal navigation is
                                // the one that centres). Centre it ourselves.
                                'centre',
                                // A decorated row (heading decorator icon, a
                                // virtual-link suffix) does not carry the heading
                                // text, so the text lookup can fail here - the
                                // line number cannot.
                                (id) => (this.plugin ? headingElementByLine(this.plugin.app, scope, id) : null),
                            );
                        }

                        const abort = new AbortController();
                        const stop = () => abort.abort();
                        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: abort.signal });
                        window.addEventListener('mousedown', stop, { capture: true, signal: abort.signal });
                        window.addEventListener('keydown', stop, { capture: true, signal: abort.signal });
                        for (const delay of [3000, 8000]) {
                            if (delay > alignWindow) break;
                            window.setTimeout(() => {
                                if (abort.signal.aborted) return;
                                // Same opt-in as the alignment above: a late
                                // re-navigation is a full jump of its own.
                                if (!this.settings.alignHeadingAfterJump) return;
                                if (alreadyFramed()) return;
                                // The measured alignment is already running. If it
                                // can find the heading it will correct the position,
                                // so a re-navigation would only re-render the whole
                                // note and fight it. Re-navigate only when the
                                // alignment has nothing to work with.
                                //
                                // Ask the alignment itself whether that is so,
                                // rather than looking the heading up again here:
                                // findHeadingElement() misses it in notes whose
                                // DOM keeps being rebuilt (MathJax typesetting a
                                // page of display math), and every miss turned
                                // into a re-navigation that yanked the view back
                                // to Obsidian's own position.
                                if (alignmentWorking) return;
                                if (findHeadingElement(document.body, headerIdToUse)) return;
                                void this.plugin.app.workspace.openLinkText(fullPath, '', false, { active: true });
                            }, delay);
                        }
                    } else {
                        // Rendered surface (reading view, HTML popover): no
                        // CodeMirror editor involved, so the measured DOM
                        // alignment is both safe and accurate there.
                        if (this.settings.alignHeadingAfterJump) {
                            keepScrolledHeadingAligned(
                                scope, 'click', alignWindow, undefined, headerIdToUse, undefined, 'centre',
                                // Same line-number fallback as the editor path.
                                (id) => (this.plugin ? headingElementByLine(this.plugin.app, scope, id) : null),
                            );
                        }
                    }
                }
                }
            };

            if (inCellEditor) {
                active!.blur();
                // 把焦点交还给主 editor，让 cell editor 彻底退出，避免导航后
                // Obsidian 恢复 cell editor 焦点（setCellFocus）时用失效的 selection 报错。
                this.plugin?.app.workspace.getActiveViewOfType(MarkdownView)?.editor.focus();
                window.setTimeout(doNav, 250);
            } else {
                doNav();
            }

            return false;
        };

        return link;
    }

    // NOTE: the span / anchor / sup elements below are created DETACHED - they
    // are appended by CodeMirror afterwards - so they must be built with
    // createElement, not with Obsidian's createEl helper. Some plugins (Media
    // Extended) replace that helper, and when it is called on a Document the
    // element ends up appended to the document itself, which throws
    // "HierarchyRequestError: Only one element on document allowed".
    getLinkRootSpan(inTableCellEditor = false) {
        const span = activeDocument.createElement('span');
        span.classList.add('virtual-link', 'virtual-link-span');

        // 这个链接正被右键锁定（菜单打开中）时，恢复 lock 状态。widget 可能
        // 在右键后被 CodeMirror 整体重建，这些类不会自己跟过来。
        if (contextLockedLinks.has(this.getLockKey())) {
            span.classList.add('virtual-link-hover-lock');
            span.dataset.fkContextLock = '1';
        }

        if (this.settings.applyDefaultLinkStyling) {
            span.classList.add('virtual-link-default');
        }

        // Add type-specific class for separate color support. Fuzzy matches get
        // their own class so they can be tinted with the fuzzy base color.
        if (this.isFuzzy) {
            span.classList.add(this.type === MatchType.Header
                ? 'virtual-link-type-fuzzy-header'
                : 'virtual-link-type-fuzzy-note');
        } else if (this.type === MatchType.Header) {
            span.classList.add('virtual-link-type-header');
        }

        // 'virtual-link-hover-lock' is the existing "do not collapse" switch
        // (the click path sets it too). Arm it on hover and release it a moment
        // after the pointer leaves, so travelling to "1|2|3" never loses them.
        span.addEventListener('mouseenter', () => {
            const pending = hoverUnlockTimers.get(span);
            if (pending !== undefined) {
                window.clearTimeout(pending);
                hoverUnlockTimers.delete(span);
            }
            span.classList.add('virtual-link-hover-lock');
            // 记住 hover 链接指向的标题，预览 popover 打开时用它精确定位，
            // 而不是按"视口顶部"猜（h1 被放到中部时那样会猜错）。
            // Clear as well as set: a link with no heading must not leave the
            // PREVIOUS hovered heading behind, or the next popover gets aligned
            // to a heading the user never hovered (previews that "centre" the
            // wrong heading entirely).
            const anchor = span.querySelector('.virtual-link-a');
            const hid = anchor?.getAttribute('data-heading-id');
            setHoveredHeadingId(hid ?? null);
        });
        span.addEventListener('mouseleave', () => {
            const pending = hoverUnlockTimers.get(span);
            if (pending !== undefined) window.clearTimeout(pending);
            // 右键菜单打开期间不要解锁：鼠标移向菜单项就会离开这个 span，
            // 一旦解锁 [1|2|3] 立刻收起，右键菜单也跟着断掉。
            if (span.dataset.fkContextLock) return;
            hoverUnlockTimers.set(span, window.setTimeout(() => {
                hoverUnlockTimers.delete(span);
                span.classList.remove('virtual-link-hover-lock');
            }, MULTI_REFERENCE_HOVER_GRACE_MS));
        });
        // 右键时阻止 CodeMirror 把光标移到点击处：光标一进入虚拟链接，CodeMirror
        // 就把整个链接替换成纯文本，[1|2|3] 列表跟着消失，也就没法"指着编号
        // 右键"了。这里只拦右键（button===2），左键/中键完全不受影响。
        span.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 2) return;
            // 加入锁定集：右键后 CodeMirror 会重建 widget，新 span 靠这个集合
            // 恢复 lock，[1|2|3] 才不会收起。菜单关闭时（unlock）移除。
            contextLockedLinks.add(this.getLockKey());
            e.preventDefault();
            e.stopPropagation();
        }, true);

        // Add context-specific classes
        if (this.isBoldContext) {
            span.classList.add('virtual-link-in-bold');
        }
        if (this.isItalicContext) {
            span.classList.add('virtual-link-in-italic');
        }
        if (this.isHighlightContext) {
            span.classList.add('virtual-link-in-highlight');
        } else {
            let parent = span.parentElement;
            while (parent) {
                if (parent.tagName === 'MARK') {
                    span.classList.add('virtual-link-in-highlight');
                    break;
                }
                parent = parent.parentElement;
            }
        }
        if (this.isTripleStarContext) {
            span.classList.add('virtual-link-in-triple-star');
        }
        if (this.isStrikethroughContext) {
            span.classList.add('virtual-link-in-strikethrough');
        }

        // ===== NEW implementation =====
        // In an editor-mode table cell Obsidian runs BOTH of its context-menu
        // pipelines (the cell editor's and the main editor's), so file-menu
        // fires twice and every plugin's menu items - ours included - end up in
        // the menu twice. Neither stopPropagation nor preventDefault can
        // suppress just one of the two pipelines, so the plugin takes over
        // completely here: both pipelines are blocked and our own menu with
        // just the virtual-link actions is shown instead.
        if (inTableCellEditor) {
            attachTableCellContextMenu(span, this);
        }
        
        return span;
    }

    getMultipleReferencesSpan(files?: TFile[], overflowCount: number = 0) {
        const spanReferences = activeDocument.createElement('span');
        if (!this.settings.alwaysShowMultipleReferences) {
            spanReferences.classList.add('multiple-files-references');
        }

        const fileList = files ?? this.files;

        if (!fileList || fileList.length === 0) {
            return spanReferences;
        }

        fileList.forEach((file, index) => {
            if (index === 0) {
                const bracket = activeDocument.createElement('span');
                bracket.textContent = '[';
                spanReferences.appendChild(bracket);
            }

            let linkText = ` ${index + 1} `;
            if (index < fileList.length - 1) {
                linkText += '|';
            }

            const linkHref = file.path;
            // Pass file parameter to use file-specific heading ID
            const link = this.getLinkAnchorElement(linkText, linkHref, file);
            spanReferences.appendChild(link);

            if (index == fileList.length - 1) {
                if (overflowCount > 0) {
                    const overflow = activeDocument.createElement('span');
                    overflow.textContent = '|...';
                    overflow.setAttribute('title', `${overflowCount} more reference(s)`);
                    spanReferences.appendChild(overflow);
                }
                const bracket = activeDocument.createElement('span');
                bracket.textContent = ']';
                spanReferences.appendChild(bracket);
            }
        });

        return spanReferences;
    }

    getMultipleReferencesIndicatorSpan() {
        const spanIndicator = activeDocument.createElement('span');
        spanIndicator.textContent = ' [...]';
        spanIndicator.classList.add('multiple-files-indicator');
        return spanIndicator;
    }

    getOverflowIndicatorSpan(hiddenCount: number) {
        const spanIndicator = activeDocument.createElement('span');
        spanIndicator.textContent = ' [...]';
        // Reuse the same class as the reference list so it shows/hides together
        // (visible on hover, or always visible when alwaysShowMultipleReferences
        // is enabled).
        if (!this.settings.alwaysShowMultipleReferences) {
            spanIndicator.classList.add('multiple-files-references');
        }
        spanIndicator.setAttribute('title', `${hiddenCount} more reference(s)`);
        return spanIndicator;
    }

    getIconSpan() {
        const suffix = this.isAlias ? this.settings.virtualLinkAliasSuffix : this.settings.virtualLinkSuffix;
        if ((suffix?.length ?? 0) > 0) {
            const icon = activeDocument.createElement('sup');
            icon.textContent = suffix;
            icon.classList.add('linker-suffix-icon');
            return icon;
        }
        return null;
    }

    /////////////////////////////////////////////////
    // Filter and sort methods
    /////////////////////////////////////////////////

    static compare(a: VirtualMatch, b: VirtualMatch): number {
        if (a.from === b.from) {
            // An exact match starting at the same position outranks a fuzzy
            // (similarity) match, even when the fuzzy one is longer. Without
            // this, "教育教学负" (fuzzy, 5 chars) would sort ahead of the exact
            // "教育教学" (4 chars) and — because filterOverlapping keeps the
            // first of an overlapping run — delete the exact match entirely.
            if (a.isFuzzy !== b.isFuzzy) {
                return a.isFuzzy ? 1 : -1;
            }
            if (b.to == a.to) {
                return b.files.length - a.files.length;
            }
            return b.to - a.to;
        }
        return a.from - b.from;
    }

    static sort(matches: VirtualMatch[]): VirtualMatch[] {
        return Array.from(matches).sort((a, b) => VirtualMatch.compare(a, b));
    }

    static filterAlreadyLinked(matches: VirtualMatch[], linkedFiles: Set<TFile>, mode: 'some' | 'every' = 'every'): VirtualMatch[] {
        return matches.filter((match) => {
            if (mode === 'every') {
                return !match.files.every((file) => linkedFiles.has(file));
            } else {
                return !match.files.some((file) => linkedFiles.has(file));
            }
        });
    }

    static filterOverlapping(matches: VirtualMatch[], onlyLinkOnce: boolean = true, excludedIntervalTree?: IntervalTree): VirtualMatch[] {
        const matchesToDelete: Map<number, boolean> = new Map();

        // Delete additions that overlap
        // Additions are sorted by from position and after that by length, we want to keep longer additions
        for (let i = 0; i < matches.length; i++) {
            const addition = matches[i];
            if (matchesToDelete.has(addition.id)) {
                continue;
            }

            // Check if the addition is inside an excluded block
            if (excludedIntervalTree) {
                const overlaps = excludedIntervalTree.search([addition.from, addition.to]);
                if (overlaps.length > 0) {
                    matchesToDelete.set(addition.id, true);
                    continue;
                }
            }

            // A fuzzy match must always yield to an exact match it overlaps.
            // The exact "苏霍姆林斯基" is only discovered when scanning reaches
            // "基", one char AFTER the fuzzy "被苏霍姆林斯" was produced — so the
            // fuzzy one starts a char earlier and, being first, would win here
            // and delete the exact match. Exact is what the user actually wrote,
            // so it must survive regardless of scanning order.
            if (addition.isFuzzy) {
                let yieldsToExact = false;
                for (let j = i + 1; j < matches.length; j++) {
                    const other = matches[j];
                    if (other.from >= addition.to) break;
                    if (!other.isFuzzy) { yieldsToExact = true; break; }
                }
                if (yieldsToExact) {
                    matchesToDelete.set(addition.id, true);
                    continue;
                }
            }

            // Set all overlapping additions to be deleted
            for (let j = i + 1; j < matches.length; j++) {
                const otherAddition = matches[j];
                if (otherAddition.from >= addition.to) {
                    break;
                }
                matchesToDelete.set(otherAddition.id, true);
            }

            // Set all additions that link to the same file to be deleted
            if (onlyLinkOnce) {
                for (let j = i + 1; j < matches.length; j++) {
                    const otherAddition = matches[j];
                    if (matchesToDelete.has(otherAddition.id)) {
                        continue;
                    }

                    if (otherAddition.files.every((f) => addition.files.contains(f))) {
                        matchesToDelete.set(otherAddition.id, true);
                    }
                }
            }
        }
        return matches.filter((match) => !matchesToDelete.has(match.id));
    }
}
