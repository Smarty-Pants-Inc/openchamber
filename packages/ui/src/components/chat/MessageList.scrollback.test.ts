import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// smarty-code#583: a continuous scroll-back moved the view whenever rows above it measured (estimated rows entering from
// above, an older page's rows), because the timeline list compensated row sizes only during a width resize. The list must
// compensate sizes while the reader is away from the live end, and must not at the live end (a tool result expanding in
// place grows downward there). LegendList itself is not mounted in these tests, so this checks the wiring.
const source = readFileSync(new URL('./MessageList.tsx', import.meta.url), 'utf8');

test('size compensation is on while reading history and during a width resize, and off at the live end', () => {
    expect(source).toContain('maintainVisibleContentPosition={{ data: true, size: isWidthResizing || readingHistory, shouldRestorePosition: isContentRow }}');
    // smarty-code#583: placeholders mount (and read) two screens ahead of the reader.
    expect(source).toContain('drawDistance={TIMELINE_DRAW_DISTANCE}');
    expect(source).toContain("import { TIMELINE_DRAW_DISTANCE } from './lib/gapWindow';");
    // smarty-code#583: a gap row is never the anchor.
    expect(source).toContain("const isContentRow = (item: TimelineEntry): boolean => item.kind !== 'gap';");
    // readingHistory follows the list's own end state: away from the end = reading history.
    expect(/isAtEndRef\.current = isAtEnd;\s*setReadingHistory\(!isAtEnd\);/.test(source)).toBe(true);
    expect(source).toContain('const [readingHistory, setReadingHistory] = React.useState(false);');
});

test('Beginning reuses the gesture-cancelled hold through late measurements', () => {
    const start = source.slice(source.indexOf('scrollToStart: () => {'), source.indexOf('scrollToBottom: () => {', source.indexOf('scrollToStart: () => {')));
    expect(start).toContain('runAnchorHold(');
    expect(start).toContain('offsetTop: 0');
});

test('the scroll hook is the sole live-end follow owner', () => {
    expect(source).toContain('maintainScrollAtEnd={false}');
});
