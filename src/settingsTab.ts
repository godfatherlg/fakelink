import { App, PluginSettingTab } from 'obsidian';
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import { t } from './lang/helpers';
import type LinkerPlugin from '../main';
import type { LinkerPluginSettings } from '../main';
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
function groupDef(heading: string, items: SettingGroupItem[], visible?: () => boolean): SettingDefinitionGroup {
    return { type: 'group', heading, items, visible };
}

export class LinkerSettingTab extends PluginSettingTab {
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
            case 'backgroundHighlight':
                await this.plugin.updateSettings({ backgroundHighlight: value as boolean });
                this.applyBodyClass('virtual-link-bg', value as boolean);
                break;
            case 'backgroundLineOpacity':
                await this.plugin.updateSettings({ backgroundLineOpacity: value as number });
                this.applyCssVar('--fakelink-line-alpha', String((value as number) / 100));
                break;
            case 'cursorLineOpacity':
                await this.plugin.updateSettings({ cursorLineOpacity: value as number });
                this.applyCssVar('--fakelink-cursor-line-alpha', String((value as number) / 100));
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

        return [
            // ---------- General ----------
            groupDef(t('General'), [
                toggleDef(t('Activate virtual linker'), 'linkerActivated', {
                    desc: t('To show/hide virtual links in the body of regular notes (paragraphs, lists, etc.), please turn on/off this toggle. Note: This toggle cannot control virtual links inside tables and Canvas (due to different rendering mechanisms). If virtual links in tables or Canvas are not displayed or show rendering glitches, do not toggle this switch — simply restart the plugin (via QuickAdd or other means).'),
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
                // 上面那项是"按目录"关闭链接生成，下面这组是"按单篇" —— 两者都是源侧
                // 排除（笔记自己不生成链接），与 Exclusions 组里那些"让笔记不被链接到"
                // 的目标侧排除相反，所以放在这里而不是 Exclusions 组。
                dropdownDef(t('Single-note opt-out'), 'linkIgnoreMode', {
                    off: t('Off — no note can opt out'),
                    tag: t('By tag'),
                    property: t('By frontmatter property'),
                }, {
                    desc: t('Lets one note switch off virtual links inside itself (the opposite of "linker-exclude", which stops it being linked from elsewhere). Pick one method; the matching field below is used.'),
                }),
                textDef(t('Opt-out tag name'), 'linkIgnoreTag', {
                    desc: t('Used when the method is "By tag": a note carrying this tag renders no virtual links at all. Put it in the frontmatter (tags: [linker-ignore]) or anywhere in the note as #linker-ignore.'),
                    placeholder: 'linker-ignore',
                    visible: () => s.linkIgnoreMode === 'tag',
                }),
                textDef(t('Opt-out property name'), 'linkIgnoreProperty', {
                    desc: t('Used when the method is "By frontmatter property": a note with this property set to true renders no virtual links at all. Usage: add "linker-ignore: true" to the note frontmatter.'),
                    placeholder: 'linker-ignore',
                    visible: () => s.linkIgnoreMode === 'property',
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
                toggleDef(t('Background'), 'backgroundHighlight', {
                    desc: t('One switch for the whole look: a very faint tint, a light blue background on list lines, on tab-indented lines (and the line above them), on tables and callouts, a warm orange highlight on the cursor line with a dark brown caret, accent styling for the active tab header, and a gentle mask while the window is unfocused. Off by default; every colour is a CSS variable (--fakelink-...).'),
                }),
                sliderDef(t('Background tint strength'), 'backgroundLineOpacity', 0, 60, 1, {
                    desc: t('Opacity of the light blue tint on list / indented / table / callout lines. 10 is the default.'),
                    visible: () => s.backgroundHighlight,
                }),
                sliderDef(t('Cursor line strength'), 'cursorLineOpacity', 0, 100, 1, {
                    desc: t('Opacity of the warm orange highlight on the line the cursor is on. 35 is the default.'),
                    visible: () => s.backgroundHighlight,
                }),
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
