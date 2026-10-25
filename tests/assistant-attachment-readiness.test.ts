import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Attachment, Snapshot } from '../packages/domain/contracts';
import type { PendingFile } from '../apps/client/src/api';
import { assistantAttachmentAccept, assistantAttachmentIssue, assistantAttachmentLimit, assistantAttachmentMime } from '../packages/domain/assistant-attachments';
import { sourceMimeTypes } from '../packages/domain/source-transfer';
import { officeAttachmentMimeTypes } from '../packages/domain/office-attachments';

test('Assistant readiness includes native formats and verified Office readings while rejecting unsupported originals', () => {
  const formats = { ...sourceMimeTypes, ...officeAttachmentMimeTypes };
  assert.deepEqual(assistantAttachmentAccept.split(',').sort(), Object.keys(formats).map(extension => `.${extension}`).sort());
  for (const [extension, mime] of Object.entries(formats)) {
    assert.equal(assistantAttachmentMime(`source.${extension.toUpperCase()}`), mime);
    assert.equal(assistantAttachmentIssue({ name: `source.${extension}`, size: assistantAttachmentLimit }), undefined);
  }
  for (const name of ['document.docm', 'workbook.xlsm', 'slides.pptm', 'legacy.doc', 'legacy.xls', 'legacy.ppt', 'source.ts', 'archive.zip', 'photo.heic', 'README', 'pdf', 'txt', 'source.__proto__', 'source.constructor']) {
    assert.equal(assistantAttachmentMime(name), undefined);
    assert.ok(assistantAttachmentIssue({ name })?.includes(name));
    assert.match(assistantAttachmentIssue({ name })!, /Your draft and saved files are kept/);
  }
  assert.match(assistantAttachmentIssue({ name: 'large.txt', size: assistantAttachmentLimit + 1 })!, /8 MB/);
});

const fixtureKey = Symbol.for('nova.test.attachment-readiness');
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/apps/client/src/useAttachments.ts')) {
      if (specifier === 'react') return { url: 'nova-test:attachment-react', shortCircuit: true };
      if (specifier === './api') return { url: 'nova-test:attachment-api', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:attachment-react') return { format: 'module', shortCircuit: true, source: `
      const fixture = () => globalThis[Symbol.for('nova.test.attachment-readiness')];
      export const useEffect = effect => { if (fixture().firstRender) fixture().effects.push(effect); };
      export const useRef = initial => {
        const f = fixture(), index = f.index++;
        if (!(index in f.values)) f.values[index] = { current: initial };
        return f.values[index];
      };
      export const useState = initial => {
        const f = fixture(), index = f.index++;
        if (!(index in f.values)) f.values[index] = typeof initial === 'function' ? initial() : initial;
        return [f.values[index], value => { f.values[index] = typeof value === 'function' ? value(f.values[index]) : value; }];
      };
    ` };
    if (url === 'nova-test:attachment-api') return { format: 'module', shortCircuit: true, source: `
      const fixture = () => globalThis[Symbol.for('nova.test.attachment-readiness')];
      export const request = (...args) => fixture().request(...args);
      export const stagedFile = (...args) => fixture().stagedFile(...args);
    ` };
    return next(url, context);
  },
});
const { useAttachments } = await import('../apps/client/src/useAttachments');
hooks.deregister();

function fixture(t: any, assistant = true, recovered: PendingFile[] = [], uploadEnabled?: boolean) {
  const snapshot = { deviceId: 'device', epoch: 'epoch' } as Snapshot;
  const original = { id: 'original', name: 'kept.txt', size: 4, sha256: 'a'.repeat(64) };
  let draft = { attachments: [original] }, reads = 0, changes = 0, retaining = true;
  const staged = new Map(recovered.map(file => [file.id, file]));
  const requests: any[] = [], writes: string[] = [];
  const state = {
    index: 0, values: [] as any[], firstRender: true, effects: [] as (() => unknown)[],
    request: async (endpoint: string, input: PendingFile) => { requests.push({ endpoint, input }); return { id: input.id, name: input.name, size: 4, sha256: 'b'.repeat(64) } as Attachment; },
    stagedFile: async (action: string, value?: PendingFile | string) => {
      if (action === 'list') return [...staged.values()];
      writes.push(action);
      if (action === 'put') staged.set((value as PendingFile).id, value as PendingFile);
      if (action === 'delete') staged.delete(value as string);
    },
  };
  class Reader {
    result = ''; onload?: () => void;
    readAsDataURL() { reads++; this.result = 'data:text/plain;base64,a2VwdA=='; this.onload?.(); }
  }
  for (const [name, value] of [[fixtureKey, state], ['FileReader', Reader]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const render = () => {
    state.index = 0; state.firstRender = state.values.length === 0;
    return useAttachments(snapshot, draft, update => { changes++; if(!retaining)return false;draft = update(draft); return true; }, 'draft:device', 'draft', { assistant, uploadEnabled });
  };
  return { render, staged, writes, requests, state, draft: () => draft, reads: () => reads, changes: () => changes,retaining(value:boolean){retaining=value;},epoch(value:string){snapshot.epoch=value;} };
}
const files = (...names: string[]) => names.map(name => new File(['kept'], name)) as unknown as FileList;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('composer rejects an unsupported selection before reading, staging or linking any files', async t => {
  const f = fixture(t), original = f.draft();
  await f.render().add(files('supported.txt', 'quarterly-report.docm'));
  assert.match(f.render().notice, /quarterly-report\.docm cannot be sent to Assistant yet/);
  assert.equal(f.reads(), 0); assert.equal(f.changes(), 0);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.draft(), original);
});

test('retained unsupported staging stays recoverable and never silently uploads or deletes', async t => {
  const oldFile = { id: 'staged-original', draftId: 'draft:device', epoch: 'epoch', deviceId: 'device', name: 'original.xlsm', base64: 'a2VwdA==' };
  const f = fixture(t, true, [oldFile]);
  f.render(); for (const effect of f.state.effects) effect(); await settle();
  const recovered = f.render();
  assert.deepEqual(recovered.pending, [oldFile]);
  assert.match(recovered.errors[oldFile.id], /original\.xlsm cannot be sent/);
  await recovered.retry(oldFile);
  assert.deepEqual(f.staged.get(oldFile.id), oldFile);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.requests, []); assert.equal(f.changes(), 0);
});

for (const [assistant, name] of [[true, 'notes.MD'], [false, 'original.docx']] as const) {
  test(`${assistant ? 'supported Assistant files' : 'general workspace originals'} still stage and link without replacing existing files`, async t => {
    const f = fixture(t, assistant);
    await f.render().add(files(name)); await settle();
    assert.equal(f.reads(), 1); assert.equal(f.requests.length, 1);
    assert.equal(f.draft().attachments[0].id, 'original'); assert.equal(f.draft().attachments[1].name, name);
    assert.equal(f.staged.size, 0); assert.deepEqual(f.writes, ['put', 'delete']);
  });
}


test('paused direct upload recovery preserves exact rows and explicit retry/add never request, read or stage', async t => {
  const oldFile = { id: 'kept-file', draftId: 'draft:device', epoch: 'epoch', deviceId: 'device', name: 'notes.txt', base64: 'a2VwdA==' };
  const f = fixture(t, true, [oldFile], false), before = structuredClone(f.draft());
  f.render(); for (const effect of f.state.effects) effect(); await settle();
  const recovered = f.render();
  assert.deepEqual(recovered.pending, [oldFile]); assert.match(recovered.notice, /uploads are paused/);
  await recovered.retry(oldFile); await recovered.add(files('new.txt')); await settle();
  assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, []); assert.equal(f.reads(), 0); assert.equal(f.changes(), 0);
  assert.deepEqual(f.staged.get(oldFile.id), oldFile); assert.deepEqual(f.draft(), before);
  await recovered.remove(oldFile.id); assert.deepEqual(f.writes, ['delete']); assert.equal(f.staged.size, 0);
});

test('ordinary default recovery still uploads and links its exact staged file', async t => {
  const oldFile = { id: 'ordinary-kept', draftId: 'draft:device', epoch: 'epoch', deviceId: 'device', name: 'notes.txt', base64: 'a2VwdA==' };
  const f = fixture(t, true, [oldFile]); f.render(); for (const effect of f.state.effects) effect(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].input.requestId, oldFile.id);
  assert.deepEqual(f.writes, ['delete']); assert.equal(f.draft().attachments[1].name, oldFile.name);
});
test('uploaded bytes with an unretained draft link preserve staging and retry the exact original request',async t=>{
 const oldFile={id:'original-upload',draftId:'draft:device',epoch:'epoch',deviceId:'device',name:'source.txt',base64:'a2VwdA=='};
 const f=fixture(t,false,[oldFile]);f.retaining(false);f.render();for(const effect of f.state.effects)effect();await settle();
 assert.deepEqual(f.staged.get(oldFile.id),oldFile);assert.equal(f.draft().attachments.length,1);assert.deepEqual(f.writes,[]);
 assert.match(f.render().errors[oldFile.id],/Uploaded bytes are safe.*cannot save/);
 f.retaining(true);await f.render().retry(oldFile);assert.equal(f.staged.size,0);assert.equal(f.draft().attachments.length,2);
 assert.equal(f.requests.length,2);assert.deepEqual(f.requests[0],f.requests[1]);assert.equal(f.requests[0].input.requestId,oldFile.id);
});
test('a late upload cannot link into a different restored workspace',async t=>{
 const oldFile={id:'late-original',draftId:'draft:device',epoch:'epoch',deviceId:'device',name:'source.txt',base64:'a2VwdA=='};
 const f=fixture(t,false,[oldFile]);let resolve:(a:Attachment)=>void=()=>{};
 f.state.request=async(endpoint,input)=>{f.requests.push({endpoint,input});return new Promise<Attachment>(accept=>{resolve=accept;});};
 f.render();for(const effect of f.state.effects)effect();await settle();f.epoch('restored-epoch');f.render();
 resolve({id:oldFile.id,name:oldFile.name,size:4,sha256:'b'.repeat(64)});await settle();
 assert.equal(f.draft().attachments.length,1);assert.deepEqual(f.staged.get(oldFile.id),oldFile);assert.deepEqual(f.writes,[]);
 assert.match(f.render().errors[oldFile.id],/upload is kept/i);
});
