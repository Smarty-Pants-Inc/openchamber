import './native-test-network';
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { areOptionalRenderRelevantMessagesEqual, areRenderRelevantMessagesEqual } from '@/components/chat/message/renderCompare';
import { author, fixture, record, target } from './675-stale-read.fixture';
import { confirmationFixture } from './confirmationRead675.fixture';
import { reconciledMetadata } from './unsaved';

const authorB = { ...author, subject: 'person-2', name: 'Person Two', image: 'https://images.example.test/two.png' };
// Keep save state and paired revisions equal, so only the author's URL changes.
// Absent/equal revision examples are split across inputs, not a duplicated cross-product.
const cases = [
  ['unparseable issuer', { ...author, issuer: 'not a URL' }, undefined, undefined],
  ['unparseable image', { ...author, image: 'not a URL' }, undefined, 7],
  ['empty issuer', { ...author, issuer: '' }, undefined, 7],
  ['empty image', { ...author, image: '' }, undefined, undefined],
  ['parseable invalid issuer path', { ...author, issuer: 'https://identity.invalid/path' }, undefined, 7],
  ['parseable invalid image javascript', { ...author, image: 'javascript:alert(1)' }, undefined, undefined],
  ['valid author B', authorB, authorB, 7],
] satisfies [string, typeof author, typeof author | undefined, number | undefined][];

// Capture every pure boundary before asserting: a parser exception must not hide
// the independent real render/comparator failures behind the first assertion.
function capture<T>(operation: () => T) {
  try { return { value: operation() }; }
  catch (error) {
    return { error: error instanceof Error ? { name: error.name, message: error.message }
      : { name: 'NonError', message: 'Unexpected thrown value' } };
  }
}

function labelState(markup: string) {
  return { empty: markup === '', hasRecordedName: markup.includes(authorB.name), hasRecordedImage: markup.includes(authorB.image) };
}

for (const [name, human, expected, revision] of cases) {
  const incoming = record('msg_675', human, revision);
  const prior = record('msg_675', author, revision);
  const sibling = record('msg_sibling', authorB, revision, 102);
  const expectedLabel = { empty: !expected, hasRecordedName: !!expected, hasRecordedImage: !!expected };

  test(`author URL ${name}: SDK loader publishes the same ID and valid sibling`, async () => {
    const f = fixture();
    await f.load([prior], 'initial');
    const read = await f.start([incoming, sibling]);
    read.release(); await read.done;
    const snapshot = f.loader.getSnapshot(target);
    expect({ status: snapshot.status, error: snapshot.error, reads: f.reads.length,
      ids: f.shown().map(info => info.id), label: capture(() => labelState(f.label())),
      human: capture(() => trustedHumanAuthor(f.shown().find(info => info.id === incoming.info.id))),
      sibling: capture(() => trustedHumanAuthor(f.shown().find(info => info.id === sibling.info.id))),
      siblingParts: f.store.getState().part[sibling.info.id],
    }).toEqual({ status: 'ready', error: null, reads: 2, ids: [incoming.info.id, sibling.info.id],
      label: { value: expectedLabel }, human: { value: expected }, sibling: { value: authorB }, siblingParts: sibling.parts });
  });

  test(`author URL ${name}: actual reducer replaces the author without throwing`, () => {
    const f = fixture();
    f.live(prior.info); f.live(sibling.info);
    const result = capture(() => f.live(incoming.info));
    expect({ result, ids: f.shown().map(info => info.id), label: capture(() => labelState(f.label())),
      human: capture(() => trustedHumanAuthor(f.shown().find(info => info.id === incoming.info.id))),
      sibling: capture(() => trustedHumanAuthor(f.shown().find(info => info.id === sibling.info.id))),
    }).toEqual({ result: { value: undefined }, ids: [incoming.info.id, sibling.info.id],
      label: { value: expectedLabel }, human: { value: expected }, sibling: { value: authorB } });
  });

  test(`author URL ${name}: exact-ID confirmation finishes with one POST and GET`, async () => {
    const f = confirmationFixture(), read = f.enqueue([incoming, sibling]), send = await f.start();
    // Promote the exact sent ID before the ambiguous receipt, as in the audit.
    // An untouched optimistic shadow would bypass the failing author comparison.
    f.live(prior.info); send.failReceipt(); await read.dispatched;
    read.release(); const outcome = await send.done;
    expect({ outcome, counts: f.counts, posts: f.posts.length, reads: f.reads.length,
      ids: f.shown().map(info => info.id), label: capture(() => labelState(f.label())),
      human: capture(() => trustedHumanAuthor(f.shown().find(info => info.id === incoming.info.id))),
      sibling: capture(() => trustedHumanAuthor(f.shown().find(info => info.id === sibling.info.id))),
      siblingParts: f.store.getState().part[sibling.info.id],
    }).toEqual({ outcome: undefined, counts: { sends: 1, confirms: 1, removes: 0 }, posts: 1, reads: 1,
      ids: [incoming.info.id, sibling.info.id], label: { value: expectedLabel },
      human: { value: expected }, sibling: { value: authorB }, siblingParts: sibling.parts });
  });

  test(`author URL ${name}: real parser, HumanAuthor and both comparators reject safely`, () => {
    const unlabelled = record('msg_675', undefined, revision);
    expect({ parser: capture(() => trustedHumanAuthor(incoming.info)),
      render: capture(() => labelState(renderToStaticMarkup(createElement(HumanAuthor, { info: incoming.info })))),
      adoption: capture(() => reconciledMetadata(prior.info, incoming.info)),
      current: capture(() => areRenderRelevantMessagesEqual(prior, incoming)),
      reverse: capture(() => areRenderRelevantMessagesEqual(incoming, prior)),
      optional: capture(() => areOptionalRenderRelevantMessagesEqual(prior, incoming)),
      unlabelled: capture(() => areRenderRelevantMessagesEqual(unlabelled, incoming)),
    }).toEqual({ parser: { value: expected }, render: { value: expectedLabel }, adoption: { value: { adopt: true } },
      current: { value: false }, reverse: { value: false }, optional: { value: false }, unlabelled: { value: !expected } });
  });
}
