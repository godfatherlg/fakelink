/**
 * Lightweight, dependency-free word stemmer used for "inflected form" matching.
 *
 * Only English is implemented with a faithful (compact) port of the Porter
 * stemming algorithm. Other languages fall back to a no-op so the plugin keeps
 * working without extra dependencies. The registry is intentionally easy to
 * extend with more languages later.
 */

type StemFn = (word: string) => string;

const step1ab = (s: string): string => {
    let k = s.length - 1;
    const adj = (n: number) => { k = n; };

    // Step 1a
    if (s.endsWith('sses')) { adj(s.length - 4); s = s.slice(0, k + 1) + 'ss'; }
    else if (s.endsWith('ies')) { adj(s.length - 4); s = s.slice(0, k + 1) + 'i'; }
    else if (s.endsWith('ss')) { adj(s.length - 1); }
    else if (s.endsWith('s') && s.length > 2) { adj(s.length - 2); }

    s = s.slice(0, k + 1);

    const vowel = (c: string) => 'aeiou'.includes(c);
    const measure = (w: string): number => {
        let m = 0; let inVowel = false;
        for (let i = 0; i < w.length; i++) {
            const v = vowel(w[i]);
            if (v && !inVowel) { m++; inVowel = true; }
            else if (!v) { inVowel = false; }
        }
        return m;
    };
    const endsWithDoublCons = (w: string): boolean => {
        if (w.length < 2) return false;
        const a = w[w.length - 1], b = w[w.length - 2];
        return a === b && !vowel(a);
    };
    const cvc = (w: string): boolean => {
        const n = w.length;
        if (n < 3) return false;
        const c1 = w[n - 1], v = w[n - 2], c2 = w[n - 3];
        return !vowel(c1) && vowel(v) && !vowel(c2) && !'wxy'.includes(c1);
    };

    // Step 1b
    const try1b = (w: string): string => {
        if (w.endsWith('eed')) {
            const stem = w.slice(0, -3);
            if (measure(stem) > 0) return stem + 'ee';
            return w;
        }
        if (w.endsWith('ed')) {
            const stem = w.slice(0, -2);
            if (stem.split('').some(vowel)) {
                return step1bSub(stem);
            }
            return w;
        }
        if (w.endsWith('ing')) {
            const stem = w.slice(0, -3);
            if (stem.split('').some(vowel)) {
                return step1bSub(stem);
            }
            return w;
        }
        return w;
    };
    const step1bSub = (stem: string): string => {
        if (stem.endsWith('at')) return stem.slice(0, -2) + 'ate';
        if (stem.endsWith('bl')) return stem.slice(0, -2) + 'ble';
        if (stem.endsWith('iz')) return stem.slice(0, -2) + 'ize';
        if (endsWithDoublCons(stem) && !'lsz'.includes(stem[stem.length - 1])) {
            return stem.slice(0, -1);
        }
        if (measure(stem) === 1 && cvc(stem)) {
            return stem + 'e';
        }
        return stem;
    };

    s = try1b(s);
    return s;
};

const step1c = (s: string): string => {
    if (s.endsWith('y')) {
        const stem = s.slice(0, -1);
        if (stem.split('').some(c => 'aeiou'.includes(c))) return stem + 'i';
    }
    return s;
};

const step2 = (s: string): string => {
    const rules: [string, string, number][] = [
        ['ational', 'ate', 0], ['tional', 'tion', 0], ['enci', 'ence', 0],
        ['anci', 'ance', 0], ['izer', 'ize', 0], ['bli', 'ble', 0],
        ['alli', 'al', 0], ['entli', 'ent', 0], ['ousli', 'ous', 0],
        ['ization', 'ize', 0], ['ation', 'ate', 0], ['ator', 'ate', 0],
        ['alism', 'al', 0], ['iveness', 'ive', 0], ['fulness', 'ful', 0],
        ['ousness', 'ous', 0], ['aliti', 'al', 0], ['iviti', 'ive', 0],
        ['biliti', 'ble', 0], ['logi', 'log', 0],
    ];
    const measure = (w: string): number => {
        let m = 0; let inVowel = false;
        for (let i = 0; i < w.length; i++) {
            const v = 'aeiou'.includes(w[i]);
            if (v && !inVowel) { m++; inVowel = true; }
            else if (!v) { inVowel = false; }
        }
        return m;
    };
    for (const [suf, rep, m] of rules) {
        if (s.endsWith(suf)) {
            const stem = s.slice(0, -suf.length);
            if (measure(stem) > m) return stem + rep;
        }
    }
    return s;
};

const step3 = (s: string): string => {
    const rules: [string, string, number][] = [
        ['icate', 'ic', 0], ['ative', '', 0], ['alize', 'al', 0],
        ['iciti', 'ic', 0], ['ical', 'ic', 0], ['ful', '', 0], ['ness', '', 0],
    ];
    const measure = (w: string): number => {
        let m = 0; let inVowel = false;
        for (let i = 0; i < w.length; i++) {
            const v = 'aeiou'.includes(w[i]);
            if (v && !inVowel) { m++; inVowel = true; }
            else if (!v) { inVowel = false; }
        }
        return m;
    };
    for (const [suf, rep, m] of rules) {
        if (s.endsWith(suf)) {
            const stem = s.slice(0, -suf.length);
            if (measure(stem) > m) return stem + rep;
        }
    }
    return s;
};

const step4 = (s: string): string => {
    const suffixes = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant',
        'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'];
    const measure = (w: string): number => {
        let m = 0; let inVowel = false;
        for (let i = 0; i < w.length; i++) {
            const v = 'aeiou'.includes(w[i]);
            if (v && !inVowel) { m++; inVowel = true; }
            else if (!v) { inVowel = false; }
        }
        return m;
    };
    for (const suf of suffixes) {
        if (s.endsWith(suf)) {
            const stem = suf === 'ion'
                ? (s.endsWith('tion') || s.endsWith('sion') ? s.slice(0, -3) : s)
                : s.slice(0, -suf.length);
            if (measure(stem) > 1) return stem;
        }
    }
    return s;
};

const step5 = (s: string): string => {
    const measure = (w: string): number => {
        let m = 0; let inVowel = false;
        for (let i = 0; i < w.length; i++) {
            const v = 'aeiou'.includes(w[i]);
            if (v && !inVowel) { m++; inVowel = true; }
            else if (!v) { inVowel = false; }
        }
        return m;
    };
    const endsWithDoublCons = (w: string): boolean => {
        if (w.length < 2) return false;
        const a = w[w.length - 1], b = w[w.length - 2];
        return a === b && !'aeiou'.includes(a);
    };
    const cvc = (w: string): boolean => {
        const n = w.length;
        if (n < 3) return false;
        const c1 = w[n - 1], v = w[n - 2], c2 = w[n - 3];
        return !'aeiou'.includes(c1) && 'aeiou'.includes(v) && !'aeiou'.includes(c2) && !'wxy'.includes(c1);
    };
    // Step 5a
    if (s.endsWith('e')) {
        const stem = s.slice(0, -1);
        if (measure(stem) > 1 || (measure(stem) === 1 && !cvc(stem))) return stem;
    }
    // Step 5b
    if (measure(s) > 1 && endsWithDoublCons(s) && s.endsWith('l')) {
        return s.slice(0, -1);
    }
    return s;
};

const porterStem = (input: string): string => {
    const word = input.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length < 3) return word;
    let s = step1ab(word);
    s = step1c(s);
    s = step2(s);
    s = step3(s);
    s = step4(s);
    s = step5(s);
    return s;
};

const registry: Record<string, StemFn> = {
    en: porterStem,
    // Add more languages here (e.g. 'de', 'fr') when implementations exist.
};

/**
 * Returns the stem of a word for the given language.
 * If the language is unsupported or stemming is not desired, returns the
 * original (trimmed, lowercased) word so callers can compare consistently.
 */
export function stem(word: string, language: string): string {
    const fn = registry[language];
    if (!fn) return word.toLowerCase();
    return fn(word);
}

export function isStemmingSupported(language: string): boolean {
    return language in registry;
}
