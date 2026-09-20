import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantOperation, AssistantOutput, Conversation, ConversationHistory, ConversationMessage } from '../packages/domain/assistant';
import type { MessagePin } from '../packages/domain/message-pins';
import { transcriptContains, groupVoiceMessages } from '../apps/client/src/voice-transcript';

const styles = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { resolveMessageActions, TranscriptCoverage } = await import('../apps/client/src/Assistant');
const { GeneratedOutput, savedMessageOutput } = await import('../apps/client/src/GeneratedOutput');
styles.deregister();

const conversation = { id: 'chat', nativeId: 'current-native', connectionGeneration: 'current-generation' } as Conversation;
const source = { bindingId: 'old-binding', nativeId: 'old-native', nativeKey: 'old-key', connectionGeneration: 'old-generation', nativeMessageId: 'old-message', kind: 'native' as const, observedAt: '2026-09-20T00:00:00Z' };
const message: ConversationMessage = { id: 'old-message', novaId: 'nova-message', role: 'assistant', runId: 'reused-run', text: 'Saved reply', textHash: 'hash', attachments: [], source };
const op = (id: string, nativeId: string): AssistantOperation => ({ id, conversationId: 'chat', nativeId, nativeRunId: 'reused-run' } as AssistantOperation);
const history = (messages: ConversationMessage[]): ConversationHistory => ({ conversationId: 'chat', nativeId: 'current-native', messages, hasMore: false, activeRunIds: null });

test('older message actions resolve their own operation and pin after account/session replacement', () => {
  const pins = [{ conversationId: 'chat', nativeId: 'old-native', messageId: 'old-message', role: 'assistant', messageHash: 'hash', pinned: true }] as MessagePin[];
  const result = resolveMessageActions(message, conversation, history([message]), [op('current-op', 'current-native'), op('old-op', 'old-native')], pins);
  assert.equal(result.nativeId, 'old-native'); assert.equal(result.operation?.id, 'old-op'); assert.equal(result.pinned, true); assert.equal(result.canFork, false);
  assert.equal(resolveMessageActions({ ...message, textHash: 'changed' }, conversation, history([]), [], pins).pinned, false);
  assert.equal(resolveMessageActions(message, conversation, history([]), [], [{ ...pins[0], nativeId: 'current-native' }]).pinned, false);
});

test('durable operation identity wins and retry cannot reuse a user message from another binding', () => {
  const first: ConversationMessage = { ...message, id: 'old-user', novaId: 'old-user-nova', role: 'user', source: { ...source, nativeMessageId: 'old-user' } };
  const unrelated: ConversationMessage = { ...first, id: 'new-user', novaId: 'new-user-nova', source: { ...source, nativeId: 'current-native', bindingId: 'new-binding' } };
  const reply = { ...message, operationId: 'exact-op' };
  const resolved = resolveMessageActions(reply, conversation, history([first, unrelated, reply]), [op('wrong-op', 'old-native'), op('exact-op', 'old-native')], []);
  assert.equal(resolved.operation?.id, 'exact-op'); assert.equal(resolved.previousUser, first);
  assert.equal(resolveMessageActions(reply, conversation, history([unrelated, reply]), [], []).previousUser, undefined);
  const reusedNative = { ...conversation, nativeId: 'old-native' };
  assert.equal(resolveMessageActions(message, reusedNative, history([]), [], []).canFork, false, 'A new host generation cannot branch the old binding even when a native id is reused');
});

test('saved output matching requires historical native id, hash, artifact and conversation', () => {
  const output = { id: 'output', conversationId: 'chat', nativeId: 'old-native', messageId: 'old-message', messageHash: 'hash', state: 'ready', artifactId: 'image' } as AssistantOutput;
  for (const wrong of [{ ...output, nativeId: 'current-native' }, { ...output, conversationId: 'other-chat' }, { ...output, messageHash: 'other-hash' }, { ...output, artifactId: 'other-file' }]) assert.equal(savedMessageOutput([wrong], conversation, message, 'image'), undefined);
  assert.equal(savedMessageOutput([output], conversation, message, 'image'), output);
  assert.equal(savedMessageOutput([output], conversation, { ...message, id: 'new-alias', aliases: ['old-message'] }, 'image'), output);
  const text = { ...output, artifactId: undefined }; assert.equal(savedMessageOutput([output, text], conversation, message), text);
});

test('a captured local image remains openable/downloadable with the Assistant disconnected', () => {
  const file = { id: 'local-image', sha256: 'content-hash', name: 'Earlier.png', mimeType: 'image/png', size: 123 };
  const props = { attachment: { name: file.name, type: 'image', localFile: file, availability: 'local' }, message, conversation, controller: { outputs: [], connection: { state: 'disconnected', generation: 'other' } }, epoch: 'epoch', blocked: true, refine: async () => {}, open: () => assert.fail('Rendering must not open a file'), contentActions: { snapshot: { epoch: 'epoch', deviceId: 'device', records: { content: [] } }, refresh: async () => {}, openContent: () => {} } } as unknown as ComponentProps<typeof GeneratedOutput>;
  const html = renderToStaticMarkup(createElement(GeneratedOutput, props));
  assert.match(html, /<button>Preview image/); assert.match(html, /<button>Open file/); assert.match(html, /href="\/api\/attachments\/local-image"/);
  assert.doesNotMatch(html, /Save output|Use in Content/);
  const unavailable = renderToStaticMarkup(createElement(GeneratedOutput, { ...props, attachment: { name: file.name, type: 'image', artifactId: 'native-image', availability: 'unavailable' } }));
  assert.match(unavailable, /<button disabled="">Preview image/);
});

test('coverage UI stays quiet for complete capture and discloses actual gaps', () => {
  const complete = { ...history([]), transcript: { revision: 1, savedMessages: 4, complete: true, conflicts: 0, unavailableAttachments: 0, bindings: [] } };
  assert.equal(renderToStaticMarkup(createElement(TranscriptCoverage, { history: complete })), '');
  const html = renderToStaticMarkup(createElement(TranscriptCoverage, { history: { ...complete, transcript: { ...complete.transcript, complete: false, conflicts: 2, unavailableAttachments: 1 } } }));
  assert.match(html, /Partial Saved Transcript/); assert.match(html, /2 Message Conflicts Kept/); assert.match(html, /1 File Not Captured Locally/);
});

test('saved reading anchors resolve exact Nova and native aliases without matching equal text', () => {
  const first = { ...message, id: 'voice:00000000-0000-4000-8000-000000000001:first', role: 'user' as const, aliases: ['original-voice-id'] };
  const second = { ...first, id: 'voice:00000000-0000-4000-8000-000000000001:second', novaId: 'second-nova', aliases: [] };
  const group = groupVoiceMessages([first, second])[0];
  assert.equal(transcriptContains(group, 'original-voice-id', 'user'), true); assert.equal(transcriptContains(group, 'nova-message', 'user'), true); assert.equal(transcriptContains(group, 'second-nova', 'user'), true);
  assert.equal(transcriptContains(group, 'original-voice-id', 'assistant'), false); assert.equal(transcriptContains(group, message.text, 'user'), false);
});
