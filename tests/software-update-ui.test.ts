import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { UpdateStatus } from '../packages/domain/software-update.js';
import { confirmedUpdateReceipt, retainedUpdateRequest, SoftwareUpdateView } from '../apps/client/src/SoftwareUpdateSettings.js';

const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  installed: { novaVersion: '1.12.11', candidateId: 'old', agent: { id: 'openclaw', name: 'OpenClaw', state: 'ready', version: '2026.9.2' } },
  availability: 'available', checkedAt: 1000, installation: { supported: true },
  release: { candidateId: 'new', novaVersion: '1.13.0', agentVersion: '2026.9.2', notes: ['A reviewed change'], downloadBytes: 1024 },
  ...patch,
});
const job = (state: NonNullable<UpdateStatus['job']>['state']): NonNullable<UpdateStatus['job']> => ({ id: 'job', candidateId: 'new', state, requestedAt: 1000, updatedAt: 2000 });
const noAction = () => assert.fail('Rendering cannot send an update command');
function render(value = status(), props: Partial<Parameters<typeof SoftwareUpdateView>[0]> = {}) {
  return renderToStaticMarkup(createElement(SoftwareUpdateView, { status: value, online: true, failed: false, pending: false, check: noAction, install: noAction, cancel: noAction, retry: noAction, ...props }));
}
function elements(html: string, tag: string) {
  const found: { attributes: Record<string, string>; text: string }[] = [];
  let current: typeof found[number] | undefined;
  new Parser({ onopentag(name, attributes) { if (name === tag) { current = { attributes, text: '' }; found.push(current); } }, ontext(text) { if (current) current.text += text; }, onclosetag(name) { if (name === tag) current = undefined; } }).end(html);
  return found;
}

test('only the fresh available reviewed pair enables installation', () => {
  assert.equal(elements(render(), 'button').find(b => b.text === 'Update now')?.attributes.disabled, undefined);
  for (const props of [{ online: false }, { failed: true }, { restricted: 'Use the owner session.' }, { busy: 'check' as const }]) {
    assert.ok('disabled' in elements(render(status(), props), 'button').find(b => b.text === 'Update now')!.attributes);
  }
  assert.ok('disabled' in elements(render(status({ installation: { supported: false, reason: 'Host setup required.' } })), 'button').find(b => b.text === 'Update now')!.attributes);
  for (const availability of ['checking', 'current', 'unavailable', 'error'] as const) assert.equal(elements(render(status({ availability })), 'button').some(b => /Update now|Update when idle/.test(b.text)), false);
  assert.ok(elements(render(status(), { restricted: 'Read-only paired device.' }), 'button').every(b => 'disabled' in b.attributes));
});

test('failed refresh cannot claim current status or a connected agent version', () => {
  for (const props of [{ failed: true }, { online: false }]) {
    const html = render(status({ availability: 'current', release: undefined }), props);
    assert.doesNotMatch(html, /Up to date|2026\.9\.2/);
    assert.match(html, /Last known: 1\.12\.11/);
  }
  assert.doesNotMatch(render(status({ installed: { ...status().installed, agent: { id: 'openclaw', name: 'OpenClaw', state: 'disconnected', version: 'old-reported-version' } } })), /old-reported-version/);
});

test('work blockers offer an idle update and active jobs prevent another installation', () => {
  const waiting = render(status({ blocker: { code: 'active_work', message: 'Assistant work is active.' } }));
  assert.ok(elements(waiting, 'button').find(b => b.text === 'Update when idle' && !('disabled' in b.attributes)));
  assert.match(waiting, /Assistant work is active/);
  for (const state of ['waiting', 'downloading', 'verifying', 'preparing', 'installing', 'restarting', 'checking'] as const) {
    const buttons = elements(render(status({ job: job(state) })), 'button');
    assert.equal(buttons.some(b => /Update now|Update when idle/.test(b.text)), false);
    assert.equal(buttons.some(b => b.text === 'Cancel update'), ['waiting', 'downloading', 'verifying'].includes(state));
  }
});

test('progress represents observed download bytes only', () => {
  const downloading = { ...job('downloading'), download: { received: 512, total: 1024 } };
  const bar = elements(render(status({ job: downloading })), 'progress')[0];
  assert.equal(bar.attributes.value, '512'); assert.equal(bar.attributes.max, '1024');
  for (const state of ['verifying', 'preparing', 'restarting', 'checking', 'completed', 'restored', 'failed'] as const) assert.equal(elements(render(status({ job: { ...downloading, state } })), 'progress').length, 0);
  for (const total of [0, NaN, Infinity]) assert.equal(elements(render(status({ job: { ...downloading, download: { received: 0, total } } })), 'progress').length, 0);
  assert.match(render(status({ job: job('checking') })), /Checking readiness/);
  assert.doesNotMatch(render(status({ job: job('checking') })), />Updated</);
  assert.match(render(status({ job: job('restored') })), /Previous version restored/);
});

test('uncertain receipts retain the original candidate and cannot offer a second update', () => {
  const saved = { epoch: 'workspace', candidateId: 'original', idempotencyKey: 'same-receipt', when: 'idle' as const };
  assert.deepEqual(retainedUpdateRequest({ ...saved, unexpected: 'omit' }, 'workspace'), saved);
  assert.equal(retainedUpdateRequest(saved, 'other-workspace'), undefined);
  for (const invalid of [null, { ...saved, when: 'automatic' }, { ...saved, idempotencyKey: 1 }]) assert.equal(retainedUpdateRequest(invalid, 'workspace'), undefined);
  const buttons = elements(render(status(), { pending: true }), 'button');
  assert.equal(buttons.some(b => /Update now|Update when idle/.test(b.text)), false);
  assert.ok(buttons.find(b => b.text === 'Reconcile update request'));
  assert.equal(confirmedUpdateReceipt(saved,status({job:job('completed')})),undefined);
  assert.equal(confirmedUpdateReceipt(saved,status({job:{...job('cancelled'),candidateId:saved.candidateId}}))?.state,'cancelled');
  assert.match(render(status(),{receipt:'Saved update request: Update cancelled.'}),/Saved update request: Update cancelled\./);
});
