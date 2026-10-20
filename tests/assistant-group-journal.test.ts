import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { changeGroup, groupReceipt, type GroupCommand } from '../packages/domain/assistant-groups';
import { GroupEditorJournal, emptyGroupEditor, originalGroupReceipt } from '../apps/client/src/assistant-group-journal';
import { ApiError } from '../apps/client/src/api';

function fixture() {
  const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID(), groupId: randomUUID() };
  const rows = new Map<string, string>(), faults = { read: false, write: false, drop: false, readback: false };
  let live = true, afterWrite = false;
  const storage = {
    getItem(key: string) { if (faults.read || afterWrite && faults.readback) { afterWrite = false; throw Error('Storage read failed'); } return rows.get(key) ?? null; },
    setItem(key: string, value: string) { if (faults.write) throw Error('Storage write failed'); if (!faults.drop) rows.set(key, value); afterWrite = true; },
  };
  const current = () => live;
  const owner = new GroupEditorJournal(storage, scope, current);
  const command: GroupCommand = { action: 'create', groupId: scope.groupId, requestId: randomUUID(), epoch: scope.epoch,
    expectedRevision: 0, title: 'Planning Circle', projectId: null, members: [], defaultAgentId: null, shareEarlierHistory: false };
  const reply = groupReceipt(changeGroup({ group: null, members: [], events: [] }, command, {
    eventId: randomUUID(), at: '2026-10-20T12:00:00.000Z', deviceId: scope.deviceId, addedMembers: [],
    actor: { profileId: 'profile:owner', revision: 0, name: 'You' },
  }));
  return { scope, rows, faults, storage, owner, command, reply, close: () => { live = false; },
    reopen: () => new GroupEditorJournal(storage, scope, current) };
}

test('complete unsaved Group fields survive reload and separate Group scopes', () => {
  const f = fixture(), draft = { ...emptyGroupEditor(), title: 'My Unsaved Group',
    members: [{ agentId: 'agent:planning', agentRevision: 3 }], defaultAgentId: 'agent:planning' };
  assert.equal(f.owner.change(draft), true);
  assert.deepEqual(f.reopen().value.draft, draft);
  assert.deepEqual(new GroupEditorJournal(f.storage, { ...f.scope, groupId: randomUUID() }, () => true).value.draft, emptyGroupEditor());
});

test('denied initial read preserves bytes and refuses effects', async () => {
  const f = fixture(); f.owner.change({ ...emptyGroupEditor(), title: 'Keep Me' }); f.faults.read = true;
  const owner = f.reopen(), original = [...f.rows]; let sent = 0;
  assert.equal(owner.invalid, true);
  await owner.send(f.command, async () => { sent++; return f.reply; });
  assert.equal(sent, 0); assert.deepEqual([...f.rows], original);
});

test('compare-and-swap refuses a competing editor without replacing either writing', () => {
  const f = fixture(), other = f.reopen();
  f.owner.change({ ...emptyGroupEditor(), title: 'First Writing' });
  const kept = f.rows.get(f.owner.key);
  assert.equal(other.change({ ...emptyGroupEditor(), title: 'Second Writing' }), false);
  assert.equal(other.value.draft.title, 'Second Writing'); assert.equal(f.rows.get(f.owner.key), kept);
});

test('persist and readback are required before the single original POST', async () => {
  for (const mode of ['write', 'drop', 'readback'] as const) {
    const f = fixture(); f.faults[mode] = true; let sent = 0;
    await f.owner.send(f.command, async () => { sent++; return f.reply; });
    assert.equal(sent, 0); assert.equal(f.owner.value.pending?.command.requestId, f.command.requestId);
    f.faults[mode] = false;
    const reply = await f.owner.continueUnsent(async command => { sent++; assert.deepEqual(command, f.command); return f.reply; });
    assert.equal(sent, 1); assert.deepEqual(reply, f.reply);
    await f.owner.continueUnsent(async () => { sent++; return f.reply; }); assert.equal(sent, 1);
  }
});

test('lost reply reload observes only the exact original and keeps newer writing', async () => {
  const f = fixture(); let sent = 0;
  await f.owner.send(f.command, async () => { sent++; throw Error('Original reply lost'); });
  f.owner.change({ ...emptyGroupEditor(), title: 'Newer Writing' });
  const reopened = f.reopen();
  await reopened.send({ ...f.command, requestId: randomUUID() }, async () => { sent++; return f.reply; });
  await reopened.continueUnsent(async () => { sent++; return f.reply; });
  const observed = await reopened.observe(async (group, request) => {
    assert.equal(group, f.scope.groupId); assert.equal(request, f.command.requestId);
    return { epoch: f.scope.epoch, view: 'request', receipt: f.reply };
  });
  assert.equal(sent, 1); assert.deepEqual(observed, f.reply); assert.equal(reopened.value.draft.title, 'Newer Writing');
  assert.equal(reopened.finish(), true);
  assert.equal(reopened.value.pending, undefined); assert.equal(reopened.value.draft.title, 'Newer Writing');
  assert.ok(f.rows.has(`${reopened.key}:confirmed:${f.command.requestId}`));
});

test('a known reply remains recoverable when acknowledgement storage fails', async () => {
  const f = fixture(); let sent = 0;
  assert.equal(await f.owner.send(f.command, async () => { sent++; f.faults.write = true; return f.reply; }), undefined);
  assert.deepEqual(f.owner.value.pending?.receipt, f.reply);
  f.faults.write = false;
  assert.deepEqual(await f.owner.observe(async () => { throw Error('Known receipt needs no GET'); }), f.reply);
  assert.equal(sent, 1);
});

test('late responses do not navigate or overwrite a replacement owner', async () => {
  const f = fixture(); let complete!: (value: unknown) => void;
  const running = f.owner.send(f.command, () => new Promise(resolve => { complete = resolve; }));
  const before = f.rows.get(f.owner.key);
  f.close(); complete(f.reply);
  assert.equal(await running, undefined); assert.equal(f.rows.get(f.owner.key), before);
  assert.deepEqual(f.owner.value.pending?.receipt, f.reply);
});

test('confirmed archive or pointer failure retains the original command', async () => {
  const f = fixture(); await f.owner.send(f.command, async () => f.reply);
  f.faults.write = true;
  assert.equal(f.owner.finish(), false); assert.deepEqual(f.owner.value.pending?.receipt, f.reply);
  f.faults.write = false; assert.equal(f.owner.finish(), true);
});

test('wrong request, epoch, group, action, revision and extra receipt fields refuse', () => {
  const f = fixture();
  for (const altered of [
    { ...f.reply, requestId: randomUUID() }, { ...f.reply, epoch: randomUUID() },
    { ...f.reply, action: 'rename' }, { ...f.reply, extra: true },
    { ...f.reply, group: { ...f.reply.group, id: randomUUID() } },
    { ...f.reply, group: { ...f.reply.group, revision: 2 } },
    { ...f.reply, group: { ...f.reply.group, title: 'Another Group' } },
  ]) assert.throws(() => originalGroupReceipt(f.scope, f.command, altered));
});

test('only exact confirmed POST rejections permit explicit archive and a separate request', async () => {
  for (const code of ['group_agent_changed', 'group_project_unavailable', 'group_revision_changed']) {
    const f = fixture(); let posts = 0, gets = 0;
    await f.owner.send(f.command, async command => {
      posts++; assert.deepEqual(command, f.command);
      f.owner.change({ ...emptyGroupEditor(), title: 'Newer Unsaved Writing' });
      throw new ApiError(code, 'Review the original choice.', undefined, 409);
    });
    const owner = f.reopen(), original = structuredClone(owner.value.pending);
    assert.deepEqual(original?.rejection, { kind: 'confirmed-pre-effect-rejection', requestId: f.command.requestId,
      epoch: f.scope.epoch, groupId: f.scope.groupId, status: 409, code, message: 'Review the original choice.' });
    assert.equal(owner.canContinueUnsent, false);
    await owner.continueUnsent(async () => { posts++; return f.reply; });
    await owner.observe(async () => { gets++; return undefined; });
    assert.equal(owner.finish(), false);
    await owner.send({ ...f.command, requestId: randomUUID() }, async () => { posts++; return f.reply; });
    assert.equal(posts, 1); assert.equal(gets, 0);
    assert.equal(owner.finishRejected(), true);
    assert.deepEqual(JSON.parse(f.rows.get(`${owner.key}:rejected:${f.command.requestId}`)!), original);
    const finishedPending = owner.value.pending;
    assert.equal(finishedPending, undefined);
    assert.equal(owner.value.draft.title, 'Newer Unsaved Writing');
    // Only this later explicit user action creates a new request; no rejection is replayed.
    const next = { ...f.command, requestId: randomUUID(), title: 'Reviewed Choice' };
    await owner.send(next, async command => { posts++; assert.deepEqual(command, next); throw Error('New reply lost'); });
    assert.equal(posts, 2); assert.deepEqual(owner.value.pending?.command, next);
  }
});

test('an attempted pointer readback can be acknowledged without replacing newer in-memory writing', async () => {
  for (const result of ['rejection', 'receipt'] as const) {
    const f = fixture();
    await f.owner.send(f.command, async () => {
      if (result === 'receipt') return f.reply;
      throw new ApiError('group_revision_changed', 'Review the current Group.', undefined, 409);
    });
    const read = f.storage.getItem, write = f.storage.setItem;
    let pointerWritten = false, denyReadback = true;
    f.storage.setItem = (key, value) => {
      write(key, value);
      if (key === f.owner.key && JSON.parse(value).pending === undefined) pointerWritten = true;
    };
    f.storage.getItem = key => {
      if (denyReadback && pointerWritten && key === f.owner.key) throw Error('Pointer readback failed');
      return read(key);
    };
    const finish = () => result === 'receipt' ? f.owner.finish() : f.owner.finishRejected();
    assert.equal(finish(), false);
    assert.equal(f.owner.value.pending?.command.requestId, f.command.requestId);
    assert.equal(f.owner.change({ ...emptyGroupEditor(), title: 'Typed After Failed Readback' }), false);
    denyReadback = false;
    assert.equal(finish(), true);
    assert.equal(f.owner.value.draft.title, 'Typed After Failed Readback');
    assert.equal(f.reopen().value.draft.title, 'Typed After Failed Readback');
    assert.equal(f.reopen().value.pending, undefined);
  }
});

test('pointer recovery never adopts merely missing pending from a foreign journal', async () => {
  const f = fixture();
  await f.owner.send(f.command, async () => { throw new ApiError('group_agent_changed', 'Review the agent.', undefined, 409); });
  const read = f.storage.getItem, write = f.storage.setItem;
  let pointerWritten = false;
  f.storage.setItem = (key, value) => {
    write(key, value);
    if (key === f.owner.key && JSON.parse(value).pending === undefined) pointerWritten = true;
  };
  f.storage.getItem = key => {
    if (pointerWritten && key === f.owner.key) throw Error('Pointer readback failed');
    return read(key);
  };
  assert.equal(f.owner.finishRejected(), false);
  f.storage.getItem = read; f.storage.setItem = write;
  const foreign = JSON.stringify({ ...f.owner.value, pending: undefined,
    draft: { ...emptyGroupEditor(), title: 'Another Owner Wrote This' } });
  f.rows.set(f.owner.key, foreign);
  assert.equal(f.owner.finishRejected(), false);
  assert.equal(f.rows.get(f.owner.key), foreign);
  assert.equal(f.owner.value.pending?.command.requestId, f.command.requestId);
});

test('known rejection persistence failures retry only local keeping', async () => {
  for (const mode of ['write', 'readback'] as const) {
    const f = fixture(); let posts = 0, gets = 0;
    await f.owner.send(f.command, async () => {
      posts++; f.faults[mode] = true;
      throw new ApiError('group_agent_changed', 'Review the agent.', undefined, 409);
    });
    assert.equal(f.owner.value.pending?.rejection?.code, 'group_agent_changed');
    assert.notEqual(f.owner.error, '');
    assert.equal(f.owner.canContinueUnsent, false);
    f.faults[mode] = false;
    await f.owner.observe(async () => { gets++; return undefined; });
    assert.equal(f.owner.error, ''); assert.equal(gets, 0); assert.equal(posts, 1);
    assert.deepEqual(f.reopen().value.pending, f.owner.value.pending);
  }
});

test('rejection archive and pointer failures keep the exact original and newer writing', async () => {
  for (const phase of ['archive-write', 'archive-readback', 'pointer-write', 'pointer-readback', 'archive-conflict'] as const) {
    const f = fixture();
    await f.owner.send(f.command, async () => { throw new ApiError('group_project_unavailable', 'Restore the Project.', undefined, 409); });
    f.owner.change({ ...emptyGroupEditor(), title: 'Preserve Newer Writing' });
    const original = structuredClone(f.owner.value), archive = `${f.owner.key}:rejected:${f.command.requestId}`;
    const read = f.storage.getItem, write = f.storage.setItem;
    let fault = true, archiveWritten = false, pointerWritten = false;
    if (phase === 'archive-conflict') f.rows.set(archive, 'Conflicting Original');
    f.storage.setItem = (key, value) => {
      if (fault && (phase === 'archive-write' && key === archive
        || phase === 'pointer-write' && key === f.owner.key && archiveWritten)) throw Error('Write refused');
      write(key, value);
      if (key === archive) archiveWritten = true;
      if (key === f.owner.key && archiveWritten) pointerWritten = true;
    };
    f.storage.getItem = key => {
      if (fault && (phase === 'archive-readback' && key === archive && archiveWritten
        || phase === 'pointer-readback' && key === f.owner.key && pointerWritten)) throw Error('Readback refused');
      return read(key);
    };
    assert.equal(f.owner.finishRejected(), false, phase);
    assert.deepEqual(f.owner.value, original, phase);
    if (phase === 'archive-conflict') {
      assert.equal(f.rows.get(archive), 'Conflicting Original');
      assert.deepEqual(f.reopen().value, original);
    } else {
      fault = false;
      assert.equal(f.owner.finishRejected(), true, phase);
      assert.deepEqual(JSON.parse(f.rows.get(archive)!), original.pending);
      assert.equal(f.reopen().value.draft.title, 'Preserve Newer Writing');
      assert.equal(f.reopen().value.pending, undefined);
    }
  }
});

test('unknown POST and all GET failures keep the original dispatched uncertainty', async () => {
  const failures = [
    Error('Network lost'),
    new ApiError('group_changed', 'Review the saved revision.', undefined, 409),
    new ApiError('group_original_unavailable', 'Original history unavailable.', undefined, 409),
    new ApiError('group_agent_changed', 'Wrong status.', undefined, 503),
    new ApiError('group_project_unavailable', 'No status.'),
    new ApiError('group_agent_changed', 'x'.repeat(2049), undefined, 409),
    { code: 'group_agent_changed', status: 409, message: 'Not an authenticated API response.' },
  ];
  for (const failure of failures) {
    const f = fixture(); let posts = 0, gets = 0;
    await f.owner.send(f.command, async () => { posts++; throw failure; });
    assert.equal(f.owner.value.pending?.rejection, undefined);
    assert.equal(f.owner.finishRejected(), false);
    for (const observed of [
      new ApiError('group_request_missing', 'No admitted request.', undefined, 404),
      new ApiError('group_agent_changed', 'A GET cannot reject a POST.', undefined, 409),
    ]) await f.owner.observe(async () => { gets++; throw observed; });
    const owner = f.reopen();
    await owner.continueUnsent(async () => { posts++; return f.reply; });
    assert.equal(posts, 1); assert.equal(gets, 2);
    assert.equal(owner.canContinueUnsent, false); assert.equal(owner.finishRejected(), false);
    assert.deepEqual(owner.value.pending?.command, f.command);
  }
});

test('a late rejected response keeps evidence in memory without writing a retired scope', async () => {
  const f = fixture(); let reject!: (error: unknown) => void;
  const running = f.owner.send(f.command, () => new Promise((_, fail) => { reject = fail; }));
  f.owner.change({ ...emptyGroupEditor(), title: 'Last Owned Writing' });
  const before = [...f.rows];
  f.close(); reject(new ApiError('group_agent_changed', 'Agent changed.', undefined, 409));
  assert.equal(await running, undefined);
  assert.deepEqual([...f.rows], before);
  assert.equal(f.owner.value.pending?.rejection?.requestId, f.command.requestId);
  assert.equal(f.owner.value.draft.title, 'Last Owned Writing');
  assert.equal(f.owner.finishRejected(), false);
});

test('a competing raw owner blocks rejection persistence and clearing without losing either draft', async () => {
  const f = fixture(); let reject!: (error: unknown) => void;
  const running = f.owner.send(f.command, () => new Promise((_, fail) => { reject = fail; }));
  const other = f.reopen(); other.change({ ...emptyGroupEditor(), title: 'Other Writing' });
  const otherRaw = f.rows.get(f.owner.key);
  reject(new ApiError('group_project_unavailable', 'Project unavailable.', undefined, 409));
  await running;
  assert.equal(f.owner.value.pending?.rejection?.code, 'group_project_unavailable');
  assert.notEqual(f.owner.error, '');
  assert.equal(f.owner.finishRejected(), false);
  assert.equal(f.rows.get(f.owner.key), otherRaw);
  assert.equal(f.rows.has(`${f.owner.key}:rejected:${f.command.requestId}`), false);
});

test('malformed or differently bound kept rejections refuse without changing original bytes', async () => {
  const f = fixture();
  await f.owner.send(f.command, async () => { throw new ApiError('group_agent_changed', 'Agent changed.', undefined, 409); });
  const kept = JSON.parse(f.rows.get(f.owner.key)!), rejection = kept.pending.rejection;
  const pendingVariants = [
    { ...kept.pending, rejection: { ...rejection, requestId: randomUUID() } },
    { ...kept.pending, rejection: { ...rejection, epoch: randomUUID() } },
    { ...kept.pending, rejection: { ...rejection, groupId: randomUUID() } },
    { ...kept.pending, rejection: { ...rejection, code: 'group_changed' } },
    { ...kept.pending, rejection: { ...rejection, extra: true } },
    { ...kept.pending, dispatched: false },
    { ...kept.pending, receipt: f.reply },
  ];
  for (const pending of pendingVariants) {
    const raw = JSON.stringify({ ...kept, pending }); f.rows.set(f.owner.key, raw);
    const owner = f.reopen(); assert.equal(owner.invalid, true);
    assert.equal(owner.finishRejected(), false); assert.equal(f.rows.get(f.owner.key), raw);
  }
});
