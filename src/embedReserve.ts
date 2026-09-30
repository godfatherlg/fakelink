import { TFile } from 'obsidian';
import { LinkerCache } from '../linker/linkerCache';
import { getHoveredHeadingId, headingElementByLine, keepScrolledHeadingAligned, markSelfInflictedLayout, resolveHeadingTarget } from '../linker/virtualLinkDom';
import type LinkerPlugin from '../main';

/**
 * Reserves the final size of PDF++ cropped page embeds, image embeds and
 * markdown embeds so their late render cannot reflow what is below them, then
 * hooks the hover-popover alignment and the reading-view click alignment. All
 * four reactions share ONE MutationObserver (four would run four callbacks for
 * every DOM change anywhere), which is why they live together as a single unit.
 */
export function registerEmbedReservation(plugin: LinkerPlugin): void {
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
                    const loaded: unknown = await plugin.loadData();
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
                        images: capMap(plugin.imageSizes, SIZE_CACHE_LIMIT),
                        pdf: capMap(plugin.pdfHeights, 300),
                        embeds: capMap(plugin.embedHeights, 300),
                        widths: tailMap(plugin.pdfWidthHeights, 50),
                        scales: tailMap(plugin.pdfScaleSamples, 50),
                    };
                    await plugin.saveData(stored);
                } catch { /* cache persistence is best-effort */ }
            })();
        }, 3000);
    };
    void (async () => {
        try {
            const loaded: unknown = await plugin.loadData();
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
                if (v && v.w > 0) plugin.imageSizes.set(k, v);
            }
            const pdf = c.pdf ?? {};
            for (const k of Object.keys(pdf)) {
                const list = asList<{ w: number; h: number }>(pdf[k]);
                if (list) plugin.pdfHeights.set(k, list);
            }
            const embeds = c.embeds ?? {};
            for (const k of Object.keys(embeds)) {
                const list = asList<{ w: number; h: number }>(embeds[k]);
                if (list) plugin.embedHeights.set(k, list);
            }
            const scales = c.scales ?? {};
            for (const k of Object.keys(scales)) {
                const list = asList<{ c: number; h: number }>(scales[k]);
                if (list) plugin.pdfScaleSamples.set(Number(k), list);
            }
            const widths = c.widths ?? {};
            for (const k of Object.keys(widths)) {
                const e = widths[k] as { h?: number; r?: number } | null;
                // Older cache entries were a bare number (no ratio) - skip
                // them, since they cannot prove the crop shapes match.
                if (e && typeof e.h === 'number' && e.h > 0 && typeof e.r === 'number' && e.r > 0) {
                    plugin.pdfWidthHeights.set(Number(k), { h: e.h, r: e.r });
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
        const list = plugin.pdfHeights.get(src) ?? [];
        const found = list.find((e) => e.w === bucket);
        if (found) found.h = height; else list.push({ w: bucket, h: height });
        while (list.length > 4) list.shift();
        plugin.pdfHeights.set(src, list);
        persistSizeCache();
    };
    // The shared-height shortcut is only valid for embeds whose crop has the
    // same SHAPE: the stored crop ratio is compared with the requested one,
    // so a differently cropped PDF in the same article is not handed the
    // wrong height (it falls back to its own ratio instead).
    const rememberPdfFallback = (width: number, height: number, ratio: number) => {
        const bucket = pdfBucket(width);
        if (bucket > 0) plugin.pdfWidthHeights.set(bucket, { h: height, r: ratio });
    };
    const recallPdfFallback = (width: number, ratio: number): number | null => {
        const bucket = pdfBucket(width);
        if (bucket <= 0) return null;
        const entry = plugin.pdfWidthHeights.get(bucket);
        if (!entry || !(entry.r > 0) || !(ratio > 0)) return null;
        return Math.abs(entry.r - ratio) / ratio <= 0.06 ? entry.h : null;
    };
    const SCALE_SAMPLES_MAX = 8;
    const rememberPdfSample = (width: number, cropHeightPt: number, renderedHeight: number) => {
        const bucket = pdfBucket(width);
        if (bucket <= 0 || !(cropHeightPt > 0) || !(renderedHeight > 0)) return;
        const list = plugin.pdfScaleSamples.get(bucket) ?? [];
        list.push({ c: Math.round(cropHeightPt), h: renderedHeight });
        while (list.length > SCALE_SAMPLES_MAX) list.shift();
        plugin.pdfScaleSamples.set(bucket, list);
        persistSizeCache();
    };
    const learnedPdfScale = (width: number): number | null => {
        const bucket = pdfBucket(width);
        const list = bucket > 0 ? plugin.pdfScaleSamples.get(bucket) : undefined;
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
        const list = plugin.pdfHeights.get(src);
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
    plugin.register(() => insertObserver.disconnect());

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
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        // Keyed by mtime too, so editing/replacing an image re-reads it.
        const key = path + '\u0000' + file.stat.mtime;
        const known = plugin.imageSizes.get(key);
        if (known) { applyImageSize(img, known); return; }
        const pending = plugin.imageSizeInflight.get(key);
        if (pending) { void pending.then((dim) => { if (dim) applyImageSize(img, dim); }); return; }
        const read = (ext === 'svg'
            ? plugin.app.vault.adapter.read(path).then((text) => parseSvgSize(text))
            : plugin.app.vault.adapter.readBinary(path).then((buf) => parseImageSize(buf)))
            .then((dim) => {
                if (dim) { plugin.imageSizes.set(key, dim); persistSizeCache(); }
                return dim;
            })
            .catch(() => null)
            .then((dim) => { plugin.imageSizeInflight.delete(key); return dim; });
        plugin.imageSizeInflight.set(key, read);
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
        const list = plugin.embedHeights.get(src) ?? [];
        const found = list.find((e) => e.w === bucket);
        if (found) found.h = height; else list.push({ w: bucket, h: height });
        while (list.length > 6) list.shift();
        plugin.embedHeights.set(src, list);
        persistSizeCache();
    };
    const recallEmbedHeight = (src: string, width: number): number | null => {
        const list = plugin.embedHeights.get(src);
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
                // Our own write changes the layout - do not let the heading
                // watcher read it as content landing and "correct" for it.
                markSelfInflictedLayout();
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
                // Same reason as above: releasing the reservation is our own
                // layout change, not content arriving.
                markSelfInflictedLayout();
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
        Math.max(3000, (plugin.settings.headingAlignWatchSeconds || 12) * 1000);

    // Inside a CodeMirror editor the view owns the scroll position, so the
    // move is handed to the editor itself - resolved to a line through the
    // metadata cache and then kept centred by MEASURING it (the same
    // treatment as a click on a heading link). Writing scrollTop into a
    // cm-scroller instead gets overwritten by the view's next measurement,
    // which is what left a preview popover showing half a heading.
    const scrollEditor = (el: HTMLElement, headingText: string, targetViewport?: number): boolean => {
        // The element's own editor first: it works for a hover popover,
        // whose view is not in the workspace's leaf list at all.
        if (plugin.centerHeadingElement(el, 8000, targetViewport)) return true;
        // Otherwise resolve through the workspace + metadata cache.
        const target = resolveHeadingTarget(plugin.app, el, headingText, null);
        if (!target) return false;
        plugin.centerHeadingLine(target.view, target.line, 8000, targetViewport);
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
        // A popover with an editor (Hover Editor) goes through scrollEditor (the
        // editor API); the plain-HTML core Page Preview has no editor, so
        // keepAligned automatically scrolls the inner scroller
        // (.markdown-preview-view) directly - only the inside, never the outer
        // .hover-popover, so the preview is no longer scrolled away / jumped as it
        // used to be.
        for (const pop of pops) {
            // Opt-in, exactly like the click path: one setting covers both
            // the jump and the hover preview. (It used to run unconditionally
            // here, so turning the setting off changed nothing on previews.)
            if (!plugin.settings.alignHeadingAfterJump) continue;
            // Use the heading id remembered on hover to locate the target exactly
            // (when the popover opens it may sit mid-view rather than at the top,
            // and guessing by the top would pick up a smaller heading above it).
            //
            // Deliberately NO baseline here, unlike the click path: a jump
            // lands on a centred heading that is worth holding, whereas a
            // popover opens at whatever position Obsidian chose for the LINK
            // - often with the heading nowhere near the middle. Holding that
            // would only preserve a wrong position, so this path CENTRES.
            const startPopoverAlign = (): void => {
                // The popover may already be gone by the time this runs.
                if (!pop.isConnected) return;
                keepScrolledHeadingAligned(
                    pop, 'popover', alignWindow(),
                    scrollEditor,
                    getHoveredHeadingId() ?? undefined,
                    undefined,
                    'centre',
                    // Same line-number fallback as the click paths: a decorated
                    // row in a Hover Editor popover does not match by text.
                    (id) => headingElementByLine(plugin.app, pop, id),
                );
            };
            // The index is built asynchronously (in chunks), so right after
            // startup the popover's content is not rendered yet and the
            // heading cannot be found - the first preview of a session then
            // silently ended up uncentred, while later ones were fine. Wait
            // for the index before starting to align.
            const cache = LinkerCache.getInstance(plugin.app, plugin.settings);
            if (cache.cache.isReady) {
                startPopoverAlign();
            } else {
                void cache.cache.readyPromise.then(startPopoverAlign);
            }
        }
    });
    // Everything has registered by now, so start watching: starting earlier
    // would run an incomplete handler list for the first insertions.
    insertObserver.observe(document.body, { childList: true, subtree: true });

    // Rendered-DOM clicks outside the editor (reading view, popovers
    // rendered as HTML). A link built by this plugin carries its own
    // onclick (getLinkAnchorElement): that handler navigates AND aligns,
    // and it knows which heading the link points at.
    //
    // This watcher used to start a SECOND alignment for the same click -
    // one with no heading name, so keepAligned falls back to "whichever
    // heading sits nearest the top". Right after a jump the linked heading
    // is not that one (it is being centred, so a neighbouring heading is
    // still at the top), so the second loop centred a NEIGHBOURING heading
    // instead: that is the "it centres and then lands somewhere wrong"
    // symptom. Two loops writing one scroller also fight each other - one
    // writes, the other pulls back - which is the jumping. So step in only
    // when the anchor has no handler of its own, e.g. a node that was
    // cloned (cloneNode copies attributes, but not the onclick property).
    plugin.registerDomEvent(document, 'click', (evt) => {
        const el = evt.target as HTMLElement | null;
        if (!el || el.closest('.cm-editor')) return;      // editor: the widget owns it
        if (!el.closest('.virtual-link, a.virtual-link-a')) return;
        const anchor = el.closest<HTMLAnchorElement>('a.virtual-link-a');
        if (anchor?.onclick) return;                      // it navigates and aligns itself
        const scope = el.closest<HTMLElement>('.hover-popover, .workspace-leaf');
        // Same opt-in as the editor path: an unmodified Obsidian jump already
        // centres the heading, and a real link proves it stays there.
        if (!plugin.settings.alignHeadingAfterJump) return;
        let domTarget: number | undefined;
        window.setTimeout(() => keepScrolledHeadingAligned(
            scope, 'dom-click', alignWindow(),
            (el, h) => scrollEditor(el, h, domTarget),
            undefined,
            (o) => { domTarget = o; },
            'centre',
        ), 60);
    }, true);
}
