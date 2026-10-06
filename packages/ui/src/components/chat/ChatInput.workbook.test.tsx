import { expect, test } from 'bun:test';
import { act } from 'react';
import { strToU8, zipSync } from 'fflate';
import { setTimeout as sleep } from 'node:timers/promises';
import { errors, mountedNativeComposer } from './composer/submit/__tests__/nativeComposer.fixture';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { directory } from '@/sync/native-draft-fixture';

for (const method of ['picker', 'drop']) {
  test(`the mounted composer shows the workbook error for ${method} without attaching a stub or losing the draft`, async () => {
    const composer = await mountedNativeComposer(false);
    try {
      await composer.replace('keep this draft');
      await act(async () => useInputStore.getState().clearAttachedFiles());
      const archive = zipSync({ 'xl/workbook.xml': strToU8('<workbook><sheets/></workbook>') });
      const file = new File([archive], 'empty.xlsx');
      errors.length = 0;
      await act(async () => {
        if (method === 'picker') {
          const input = composer.dom.container.querySelector('input[type="file"]');
          if (!input) throw new Error('Composer file input missing');
          Object.defineProperty(input, 'files', { value: [file], configurable: true });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          const transfer = new composer.dom.window.DataTransfer();
          Object.defineProperty(transfer, 'files', { value: [file] });
          // Happy DOM has no native DragEvent payload; supply its standard dataTransfer field.
          const drop = new Event('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(drop, 'dataTransfer', { value: transfer });
          composer.editor().dom.parentElement?.dispatchEvent(drop);
        }
        for (let attempt = 0; attempt < 100 && errors.length === 0; attempt += 1) await sleep(1);
      });
      expect(errors).toEqual(["Couldn't read this workbook: no sheets or cells found"]);
      expect(useInputStore.getState().attachedFiles).toEqual([]);
      expect(composer.text()).toBe('keep this draft');
    } finally {
      await composer.dispose();
    }
  });
}

// SEC551 P2.5: a batch prepared for draft A must not continue into draft B. The first
// file read is held open while the owner changes; nothing from the batch may then reach B.
// Bun has no FileReader; this one completes a data-URL read only after release().
const holdFileReads = () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  class HeldFileReader {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      started.push(blob instanceof File ? blob.name : 'blob');
      void gate.then(async () => {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload?.();
      });
    }
  }
  Object.defineProperty(globalThis, 'FileReader', { value: HeldFileReader, configurable: true, writable: true });
  return { started, release, restore: () => {
    if (previous) Object.defineProperty(globalThis, 'FileReader', previous);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  } };
};

const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

for (const method of ['picker', 'drop', 'file paste', 'mixed paste']) {
  test(`SEC551 P2.5 drops the rest of a ${method} batch when a new draft opens`, async () => {
    const composer = await mountedNativeComposer(false);
    const reads = holdFileReads();
    try {
      await composer.replace('draft A');
      await act(async () => useInputStore.getState().clearAttachedFiles());
      const first = new File(['first'], 'first.md', { type: 'text/plain' });
      const second = method === 'mixed paste'
        ? new File([pngBytes], 'photo.png', { type: 'image/png' })
        : new File(['second'], 'second.md', { type: 'text/plain' });
      errors.length = 0;
      await act(async () => {
        if (method === 'picker') {
          const input = composer.dom.container.querySelector('input[type="file"]');
          if (!input) throw new Error('Composer file input missing');
          Object.defineProperty(input, 'files', { value: [first, second], configurable: true });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (method === 'drop') {
          const transfer = new composer.dom.window.DataTransfer();
          Object.defineProperty(transfer, 'files', { value: [first, second] });
          const drop = new Event('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(drop, 'dataTransfer', { value: transfer });
          composer.editor().dom.parentElement?.dispatchEvent(drop);
        } else {
          const paste = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(paste, 'clipboardData', { value: {
            files: [first, second],
            items: [],
            getData: (type: string) => (type === 'text' && method === 'mixed paste' ? 'clipboard words' : ''),
          } });
          composer.editor().contentDOM.dispatchEvent(paste);
        }
        for (let attempt = 0; attempt < 200 && reads.started.length === 0; attempt += 1) await sleep(1);
      });
      expect(reads.started).toEqual(['first.md']);

      await act(async () => useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory }));
      await composer.replace('draft B');
      await act(async () => {
        reads.release();
        await sleep(100);
      });

      expect(reads.started).toEqual(['first.md']);
      expect(useInputStore.getState().attachedFiles).toEqual([]);
      expect(composer.text()).toBe('draft B');
      expect(errors).toEqual([]);
    } finally {
      reads.restore();
      await composer.dispose();
    }
  });
}

test('SEC551 P2.5 control: an uninterrupted picker batch attaches every file', async () => {
  const composer = await mountedNativeComposer(false);
  const reads = holdFileReads();
  try {
    await act(async () => useInputStore.getState().clearAttachedFiles());
    const files = [new File(['first'], 'first.md', { type: 'text/plain' }), new File(['second'], 'second.md', { type: 'text/plain' })];
    await act(async () => {
      const input = composer.dom.container.querySelector('input[type="file"]');
      if (!input) throw new Error('Composer file input missing');
      Object.defineProperty(input, 'files', { value: files, configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      reads.release();
      for (let attempt = 0; attempt < 200 && useInputStore.getState().attachedFiles.length < 2; attempt += 1) await sleep(1);
    });
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(['first.md', 'second.md']);
  } finally {
    reads.restore();
    await composer.dispose();
  }
});
