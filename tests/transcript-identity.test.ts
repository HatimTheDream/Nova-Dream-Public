import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument, DomUtils } from 'htmlparser2';
import type { ConversationMessage } from '../packages/domain/assistant';
import { groupVoiceMessages } from '../apps/client/src/voice-transcript';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { TranscriptIdentity, MessageWriting, messageSpeaker } = await import('../apps/client/src/TranscriptIdentity');
const { SavedMessageText } = await import('../apps/client/src/ReplyText');
const { VoiceMessage } = await import('../apps/client/src/VoiceMessage');
styles.deregister();

const message = (role: ConversationMessage['role'], text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({ id: `${role}-original`, role, text, textHash: 'original-hash', attachments: [], ...extra });
const all = (root: any): any[] => [root, ...(root.children ?? []).flatMap(all)];
const byClass = (root: any, name: string) => all(root).filter(node => node.attribs?.class?.split(' ').includes(name));
const plain = (root: any) => DomUtils.textContent(root);
const render = (item: ConversationMessage, badge?: string) => parseDocument(renderToStaticMarkup(createElement(Fragment, null,
  createElement(TranscriptIdentity, { message: item, badge }),
  createElement(MessageWriting, { message: item, children: createElement(SavedMessageText, { message: item }) }),
)));

test('captured roles label writing without borrowing an agent name from its contents', () => {
  const items = [message('user', 'Call me Nova. Keep these exact words.'), message('assistant', 'A quoted agent name is not my captured identity.')];
  const before = structuredClone(items);
  for (const [index, item] of items.entries()) {
    Object.freeze(item);
    const tree = render(item), writing = byClass(tree, 'message-writing')[0], identity = byClass(tree, 'transcript-identity')[0];
    assert.equal(plain(byClass(identity, 'transcript-identity-name')[0]), index ? 'Nova' : 'You');
    assert.equal(byClass(writing, 'transcript-identity').length, 0, 'the speaker is outside the writing');
    assert.ok(plain(writing).includes(item.text));
    assert.equal(byClass(identity, 'transcript-identity-avatar')[0].attribs['aria-hidden'], 'true');
  }
  assert.deepEqual(items, before);
});

test('source-match label stays outside the exact authored writing', () => {
  const item = message('user', 'Transport envelope', { authoredText: 'Original user writing\nwith its own line break.' });
  const tree = render(item, 'Source Message'), writing = byClass(tree, 'message-writing')[0];
  assert.equal(plain(writing), item.authoredText);
  assert.equal(plain(byClass(tree, 'match-label')[0]), 'Source Message');
  assert.equal(byClass(writing, 'match-label').length, 0);
});

test('attachment-only user rows avoid an empty bubble without hiding empty saved-message recovery text', () => {
  const attachment = { name: 'Kept source.txt', artifactId: 'original-file' };
  const attached = render(message('user', '', { attachments: [attachment] }));
  assert.equal(byClass(attached, 'message-writing').length, 0);
  assert.equal(plain(byClass(attached, 'transcript-identity-name')[0]), 'You');
  assert.match(plain(render(message('user', ''))), /This saved message has no text or files/);
});

test('tool and system records are never presented as a person or a named-agent reply', () => {
  const items = [message('tool', 'Saved tool output'), message('system', 'Saved conversation note'), message('assistant', '', { toolInfo: { id: 'tool', name: 'read', state: 'called' } })];
  for (const item of items) {
    assert.equal(messageSpeaker(item), undefined);
    assert.equal(byClass(render(item), 'transcript-identity').length, 0);
    assert.equal(byClass(render(item), 'message-writing').length, 0);
  }
});

test('grouped voice keeps one speaker, original message anchor and exact text while actions remain outside writing', () => {
  const call = '00000000-0000-4000-8000-000000000001';
  const first = message('user', 'Keep the first thought.', { id: `voice:${call}:one` });
  const second = message('user', 'And the second thought.', { id: `voice:${call}:two` });
  const grouped = groupVoiceMessages([first, second])[0];
  const original = structuredClone(grouped);
  let originalPartRenders = 0;
  const tree = parseDocument(renderToStaticMarkup(createElement(VoiceMessage, { message: { ...grouped, unconfirmed: true, retainedVoice: true }, renderPart: () => { originalPartRenders++; return null; } })));
  const article = all(tree).find(node => node.name === 'article'), writing = byClass(tree, 'message-writing')[0];
  assert.equal(article.attribs.id, `message-${first.id}`);
  assert.equal(byClass(tree, 'transcript-identity').length, 1);
  assert.equal(plain(writing), `${first.text} ${second.text}`);
  assert.equal(byClass(writing, 'message-actions').length, 0);
  assert.ok(all(article).some(node => node.name === 'button' && node.attribs['aria-label'] === 'Copy message'));
  assert.match(plain(tree), /Unconfirmed Transcription.*Kept On This Device/s);
  assert.doesNotMatch(plain(writing), /Unconfirmed Transcription/);
  assert.equal(originalPartRenders, 0, 'presenting identity does not open or re-run original parts');
  assert.deepEqual(grouped, original);
});
