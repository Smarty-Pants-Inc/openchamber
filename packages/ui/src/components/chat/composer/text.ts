/**
 * Text-splicing rules for the composer.
 *
 * Everything that inserts into the prompt — dictation, preset chips, pasted
 * images, dropped files, revert-to-message — has to decide how the new text
 * meets the text already there. These are those decisions, kept together and
 * away from the component so they can be reasoned about (and tested) as plain
 * string functions.
 */

/**
 * Append `next` as its own block, separated by a blank line, and leave a blank
 * line after it so the user's caret starts on a fresh paragraph. Used when the
 * inserted text is a self-contained chunk (a reverted message, a quoted
 * excerpt) rather than a continuation of the sentence.
 */
export function appendWithLineBreaks(base: string, next: string): string {
    return appendOwnedBlock(base, next).text;
}

/** `appendWithLineBreaks`, with the offset where `next` starts: the joined block's place, for `removeOwnedBlock`. */
export function appendOwnedBlock(base: string, next: string): { text: string; at: number } {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return { text: `${base}${separator}${nextWithTrailingBreaks}`, at: base.length + separator.length };
}

/**
 * Remove the block that `appendOwnedBlock` joined at `at`, only while it is still there unedited: exactly `block`, at
 * that offset, a whole block (at the start or after a blank line; at the end or before a blank line). Another copy of
 * the same text elsewhere is never taken for it. The right boundary counts the block's own trailing newlines with the
 * separator joined after it, as `appendOwnedBlock` does (review r2 1). Returns null otherwise (edited, moved or gone:
 * the person's text now), else the remaining text and how many characters went (smarty-code#962).
 */
export function removeOwnedBlock(text: string, block: string, at: number): { text: string; removed: number } | null {
    const core = block.replace(/\n+$/, '');
    if (!core || at < 0 || !text.startsWith(block, at)) return null;
    if (at > 0 && !text.slice(0, at).endsWith('\n\n')) return null;
    const after = text.slice(at + core.length);
    const breaks = after.length - after.replace(/^\n+/, '').length;
    // At the end (only newlines follow) or before a blank line; a single newline is an edited continuation.
    if (breaks < after.length && breaks < 2) return null;
    const rest = text.slice(0, at) + after.slice(breaks);
    return { text: rest.trim() ? rest : '', removed: text.length - rest.length };
}

/**
 * Where the block joined at `at` (`length` characters) is after the composer changed from `prev` to `next`: shifted
 * by an edit wholly before it, the same after an edit wholly after it, and -1 (no longer owned) when the edit deletes,
 * replaces or inserts inside it. An edit of repeated text could have happened at several places; every one counts, so
 * deleting one of two equal blocks gives up ownership rather than guess which (review r3 1, smarty-code#962).
 */
export function shiftOwnedBlock(prev: string, next: string, at: number, length: number): number {
    if (at < 0 || prev === next) return at;
    const shortest = Math.min(prev.length, next.length);
    let head = 0;
    while (head < shortest && prev[head] === next[head]) head++;
    let tail = 0;
    while (tail < shortest && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    // The changed span of `prev` over every alignment: from the latest-matching start to the earliest-matching end.
    const from = Math.min(head, shortest - tail);
    const to = prev.length - Math.min(tail, shortest - head);
    if (to <= at) return at + next.length - prev.length;
    return from >= at + length ? at : -1;
}

/**
 * Append `next` to the end of the current sentence, with exactly one space
 * between them and a trailing space so the user can keep typing. Used for
 * dictation and for file mentions added from a drop.
 */
export function appendInlineText(base: string, next: string): string {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
}

/**
 * Pad an insertion so it does not fuse with its neighbours, without adding
 * space where the surrounding punctuation already reads correctly: no space
 * after an opening bracket, none before a closing one or before sentence
 * punctuation.
 */
export function withInlineInsertionBoundaries(
    content: string,
    before: string,
    after: string,
): string {
    if (!content) {
        return content;
    }

    const needsLeadingSpace = before.length > 0
        && !/\s$/.test(before)
        && !/^\s/.test(content)
        && !/[([{]$/.test(before);
    const needsTrailingSpace = after.length > 0
        && !/\s$/.test(content)
        && !/^\s/.test(after)
        && !/^[\])}.,;:!?]/.test(after);

    return `${needsLeadingSpace ? ' ' : ''}${content}${needsTrailingSpace ? ' ' : ''}`;
}

/**
 * Pasting an image alongside text: the citation goes after whatever text came
 * with it, separated by a space.
 */
export function buildImagePasteInsertion(pastedText: string, citationText: string): string {
    if (!pastedText) {
        return citationText;
    }
    return `${pastedText}${/\s$/.test(pastedText) ? '' : ' '}${citationText}`;
}

/**
 * A single-line URL pasted over a selection becomes a markdown link rather
 * than replacing the selected text.
 */
const PASTE_LINK_URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;

/**
 * Whether a pasted URL should wrap the selection as `[selected](url)`. A URL
 * containing whitespace is not one, and text that already looks like a link
 * is left alone rather than nested.
 */
export function shouldWrapSelectionAsLink(url: string, selected: string): boolean {
    return PASTE_LINK_URL_PATTERN.test(url)
        && !/\s/.test(url)
        && selected.trim().length > 0
        && !selected.includes('](');
}

const MARKDOWN_WRAP_PAIRS: Record<string, [string, string]> = {
    '`': ['`', '`'],
    '*': ['*', '*'],
    '_': ['_', '_'],
    '~': ['~', '~'],
    '(': ['(', ')'],
    '[': ['[', ']'],
    '{': ['{', '}'],
    '"': ['"', '"'],
    "'": ["'", "'"],
};

/**
 * Markdown source-mode conveniences handled before CodeMirror inserts a key.
 * The returned text change and selection belong to one editor transaction so
 * the caret cannot be applied against the previous document.
 */
export function getMarkdownAutoPairEdit(
    value: string,
    key: string,
    selectionStart: number,
    selectionEnd: number,
): {
    from: number;
    to: number;
    insert: string;
    selectionStart: number;
    selectionEnd: number;
} | null {
    const pair = MARKDOWN_WRAP_PAIRS[key];
    if (selectionEnd > selectionStart && pair) {
        const selected = value.slice(selectionStart, selectionEnd);
        const [open, close] = pair;
        return {
            from: selectionStart,
            to: selectionEnd,
            insert: `${open}${selected}${close}`,
            selectionStart: selectionStart + open.length,
            selectionEnd: selectionEnd + open.length,
        };
    }

    if (key === '`' && selectionStart === selectionEnd) {
        const before = value.slice(0, selectionStart);
        if (/(^|\n)``$/.test(before)) {
            return {
                from: selectionStart,
                to: selectionEnd,
                insert: '`\n\n```',
                selectionStart: selectionStart + 2,
                selectionEnd: selectionStart + 2,
            };
        }
    }

    return null;
}
