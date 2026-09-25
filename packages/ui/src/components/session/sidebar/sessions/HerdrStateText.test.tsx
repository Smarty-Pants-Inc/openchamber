import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HerdrStateText } from './HerdrStateText';

test("a focused Herdr row's button names its state for screen readers; a stock row adds nothing (smarty-code#126 F4)", () => {
  const html = renderToStaticMarkup(<button type="button">dev-lead<HerdrStateText label="Working" /></button>);
  expect(html).toBe('<button type="button">dev-lead<span class="sr-only" data-herdr-state-text="true">Working</span></button>');
  expect(renderToStaticMarkup(<button type="button">stock<HerdrStateText label={null} /></button>)).toBe('<button type="button">stock</button>');
});
