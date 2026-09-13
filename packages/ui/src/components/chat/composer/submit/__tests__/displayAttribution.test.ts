import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isIMECompositionEvent } from '../../../../../lib/ime';
import { saveDisplayName } from '../../../../../lib/messages/displayName';
import { planLocalSlashCommand } from '../slashCommands';

const composer = readFileSync(new URL('../../../ChatInput.tsx', import.meta.url), 'utf8');
const choice = readFileSync(new URL('../../ui/DisplayNameChoice.tsx', import.meta.url), 'utf8');

// No DOM test runtime is installed. Execute the actual inline decision guards,
// and bind their position to the production handler; this is not rendered UI proof.
test('named whitespace commands stop before planning or consuming the composer', () => {
  const submit = composer.slice(composer.indexOf('const handleSubmit = async'));
  const start = submit.indexOf('if (displayName && inputSnapshot.message.');
  const end = submit.indexOf('if (queuedOnly && autoReviewRunning)', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(end).toBeLessThan(submit.indexOf('planLocalSlashCommand('));
  expect(end).toBeLessThan(submit.indexOf("setMessage('')"));
  expect(end).toBeLessThan(submit.indexOf('await '));
  const decide = new Function('displayName', 'inputSnapshot', 'toast', 't',
    `${submit.slice(start, end)} return 'continue';`);

  for (const text of [' /btw question', '\n/compact']) {
    const draft = { message: text, hasContent: true };
    const context = ['keep attachment'];
    const effects: string[] = [];
    const errors: string[] = [];
    const next = decide('Paul', draft, { error: (key: string) => errors.push(key) }, (key: string) => key);
    if (next === 'continue') {
      // These operations are all downstream of the early production return.
      effects.push('fork', 'summarize', 'prompt', 'queue');
      draft.message = '';
      context.length = 0;
    }
    expect(errors).toEqual(['chat.displayName.plainOnly']);
    expect(effects).toEqual([]);
    expect(draft).toEqual({ message: text, hasContent: true });
    expect(context).toEqual(['keep attachment']);
    expect(decide(undefined, draft, { error: () => { throw new Error('Legacy refusal'); } }, (key: string) => key))
      .toBe('continue');
    expect(planLocalSlashCommand(text, 'normal', false, true)?.command.name)
      .toBe(text.includes('btw') ? 'btw' : 'compact');
  }
});

test('display-name Enter leaves IME confirmation alone and applies the final value once', () => {
  const handler = choice.match(/onKeyDown=\{\(event\) => \{([\s\S]*?)\n\s*\}\} \/>/);
  expect(handler).not.toBeNull();
  if (!handler) throw new Error('Display-name key handler not found');
  expect(handler[1].indexOf('isIMECompositionEvent(event)')).toBeLessThan(handler[1].indexOf("event.key === 'Enter'"));
  const keyDown = new Function('event', 'isIMECompositionEvent', 'apply', handler[1]);
  const writes: string[] = [];
  let applies = 0;
  let prevented = 0;
  let stopped = 0;
  const apply = () => {
    saveDisplayName({ setItem: (_key, value) => { writes.push(value); }, removeItem: () => {} }, '最終');
    applies++;
  };
  const enter = (isComposing: boolean, keyCode: number) => ({
    key: 'Enter', nativeEvent: { isComposing, keyCode },
    preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; },
  });
  keyDown(enter(true, 13), isIMECompositionEvent, apply);
  keyDown(enter(false, 229), isIMECompositionEvent, apply);
  expect([applies, prevented, stopped]).toEqual([0, 0, 0]);
  expect(writes).toEqual([]);
  keyDown(enter(false, 13), isIMECompositionEvent, apply);
  expect([applies, prevented, stopped]).toEqual([1, 1, 1]);
  expect(writes).toEqual(['最終']);
});

test('the control, Send and Queue read the same applied-choice authority', () => {
  const queue = composer.slice(composer.indexOf('const handleQueueMessage ='), composer.indexOf('const handleQueuedMessageEdit ='));
  const send = composer.slice(composer.indexOf('const handleSubmit = async'), composer.indexOf('// Update ref with latest handleSubmit'));
  expect(queue).toContain('if (browserDisplayName.read())');
  expect(send).toContain('displayName = browserDisplayName.read()');
  expect(choice).toContain('const current = browserDisplayName.read()');
  expect(choice).toContain('browserDisplayName.apply(name)');
  expect(choice).toContain('browserDisplayName.useUnnamedForTab()');
  for (const source of [queue, send, choice]) expect(source).not.toContain('window.sessionStorage');
});
