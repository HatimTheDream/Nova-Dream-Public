import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AssistantObservations } from '../apps/service/assistant-observations.js';
import { toolImage } from '../packages/domain/assistant-observation.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

test('visual observations accept only real bounded inline images, never remote or local paths', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  assert.deepEqual(toolImage({ content: [{ type: 'text', text: 'ignore me' }, image] }), { mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.equal(toolImage({ image_url: 'https://example.com/secret', path: '/private/file' }), undefined);
  assert.equal(toolImage({ content: [{ ...image, mimeType: 'image/svg+xml' }] }), undefined);
  assert.equal(toolImage({ content: [{ ...image, data: 'a'.repeat(13*1024*1024) }] }), undefined);
  assert.equal(phoneRouteAllowed(`/api/assistant/observation/${randomUUID()}`, 'GET'), true);
  assert.equal(phoneRouteAllowed('/workspace/observation', 'POST'), false);
});

test('screenshots bind exact epoch, session and run; replacement/removal cannot reveal stale frames', async () => {
  const epoch = randomUUID(), operation = { id: randomUUID(), epoch, conversationId: randomUUID(), nativeKey: 'e3:fixture', nativeId: randomUUID(), nativeRunId: randomUUID(), connectionGeneration: randomUUID() };
  const conversation = { id: operation.conversationId, nativeId: operation.nativeId, connectionGeneration: operation.connectionGeneration, deleted: false };
  const store = { epoch }, assistant = { operations: () => [operation], conversations: () => [conversation] };
  const service = new AssistantObservations(store as any, assistant as any);
  const bytes = await sharp({ create: { width: 24, height: 12, channels: 3, background: '#f7f6f2' } }).png().toBuffer();
  const input = { epoch, nativeKey: operation.nativeKey, nativeId: operation.nativeId, runId: operation.nativeRunId, toolName: 'computer-use.screenshot', toolCallId: 'observed-call', image: { mimeType: 'image/png', data: bytes.toString('base64') } };
  await assert.rejects(service.accept({ ...input, nativeId: randomUUID() }), /matching workspace run/);
  await assert.rejects(service.accept({ ...input, runId: randomUUID() }), /matching workspace run/);
  await service.accept(input);
  const view = service.read(operation.id)!; assert.equal(view.width, 24); assert.equal(view.height, 12); assert.equal(view.toolCallId, 'observed-call');
  assert.equal((await sharp(service.image(operation.id, view.id)).metadata()).format, 'webp');
  await service.accept({ ...input, toolCallId: 'next-call' });
  assert.throws(() => service.image(operation.id, view.id), /newer view/);
  conversation.deleted = true; assert.throws(() => service.read(operation.id), /original conversation changed/);
});
