import { expect, test } from 'bun:test';
import { act } from 'react';
import { strToU8, zipSync } from 'fflate';
import { setTimeout as sleep } from 'node:timers/promises';
import { errors, mountedNativeComposer } from './composer/submit/__tests__/nativeComposer.fixture';
import { useInputStore } from '@/sync/input-store';

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
