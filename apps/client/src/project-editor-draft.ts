import { z } from 'zod';
import { canonical, commandSchema, projectSchema, type Project } from '../../../packages/domain/contracts';
import type { AssistantSpace } from '../../../packages/domain/assistant-space';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage: Storage = {
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
};
const projectId = z.string().max(100).regex(/^project:[a-zA-Z0-9:_-]+$/);
const draftSchema = projectSchema.extend({ name: z.string().max(100) });
const formSchema = draftSchema.extend({ attachments: projectSchema.shape.attachments.default([]) });
const legacySchema = z.object({ value: draftSchema, command: commandSchema.optional() }).strict();
const indexSchema = z.object({ format: z.literal(1), id: projectId, legacy: z.object({ raw: z.string().max(1000000), epoch: z.string().uuid() }).strict() }).strict();
const journalSchema = z.object({
  value: formSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), epoch: z.string().uuid(), dirty: z.boolean(), pending: commandSchema.optional(),
  conflict: z.object({ code: z.string(), message: z.string(), current: z.object({ id: projectId, revision: z.number().int().positive(), updatedAt: z.string(), deviceId: z.string(), value: formSchema }).strict().optional() }).strict().optional(),
}).strict();
type ProjectJournal = z.infer<typeof journalSchema>;
export type ProjectDraftIdentity = {
  id: string;
  indexKey?: string;
  indexRaw?: string;
  previousIndexRaw?: string;
  journalKey?: string;
  initialJournal?: { value?: ProjectJournal };
  legacy?: { key: string; raw: string; journalKey: string; journalRaw: string; resumed: boolean };
};

/** A damaged or inaccessible journal is never an empty Project. Preserve raw bytes. */
function readProjectJournal(id: string, key: string, io: Storage): ProjectJournal | undefined {
  const raw = io.getItem(key);
  if (raw === null) return;
  const value = journalSchema.parse(JSON.parse(raw));
  const command = value.pending;
  if (command && (command.kind !== 'project' || command.entityId !== id || command.epoch !== value.epoch || command.expectedRevision !== value.revision || !value.dirty || !projectSchema.safeParse(command.payload).success) || value.conflict?.current && value.conflict.current.id !== id) {
    throw Error('The kept Project save does not match this draft. Its original writing is unchanged.');
  }
  return { ...value, value: { ...value.value, attachments: value.value.attachments ?? [] } };
}
function legacySource(raw: string, id: string, key: string, journalKey: string, epoch: string, resumed: boolean) {
  const legacy = legacySchema.parse(JSON.parse(raw));
  if (legacy.command && (legacy.command.kind !== 'project' || legacy.command.entityId !== id || !projectSchema.safeParse(legacy.command.payload).success)) throw Error('The kept Project command needs review. Its original writing is unchanged.');
  return { key, raw, journalKey, resumed,
    journalRaw: JSON.stringify({ value: { ...legacy.value, attachments: legacy.value.attachments ?? [] } satisfies Project, revision: legacy.command?.expectedRevision ?? 0, epoch: legacy.command?.epoch ?? epoch, dirty: true, pending: legacy.command }),
  };
}

/** Read absence distinctly from unreadable storage. Never replace an unknown index. */
export function readProjectDraftIdentity(scope: { deviceId: string; windowId: string; epoch: string; space: AssistantSpace; projectId?: string }, io = storage): ProjectDraftIdentity {
  const journalKey = (id: string) => `e3:journal:${scope.deviceId}:${id}:${scope.windowId}`;
  if (scope.projectId) return { id: projectId.parse(scope.projectId), journalKey: journalKey(scope.projectId) };
  const indexKey = `e3:new-project:${scope.deviceId}:${scope.windowId}:${scope.space}`;
  const raw = io.getItem(indexKey);
  const legacyKey = `e3:project-editor:${scope.deviceId}`;
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'string') {
      const index = indexSchema.parse(parsed);
      if (scope.space !== 'chat') throw Error('The kept Project import belongs to Chat. Its original writing is unchanged.');
      return { id: index.id, indexKey, indexRaw: raw, journalKey: journalKey(index.id), legacy: legacySource(index.legacy.raw, index.id, legacyKey, journalKey(index.id), index.legacy.epoch, true) };
    }
    const id = projectId.parse(parsed), identity: ProjectDraftIdentity = { id, indexKey, indexRaw: raw, journalKey: journalKey(id) };
    // Older app versions kept only a string pointer. Adopt legacy provenance
    // only when the original command identity or unchanged full value proves it.
    const legacyRaw = scope.space === 'chat' ? io.getItem(legacyKey) : null;
    if (legacyRaw !== null) {
      const legacy = legacySchema.parse(JSON.parse(legacyRaw)), journal = readProjectJournal(id, journalKey(id), io);
      if (!journal || (legacy.command ? legacy.command.kind !== 'project' || legacy.command.entityId !== id || canonical(journal.pending) !== canonical(legacy.command) || journal.epoch !== legacy.command.epoch || journal.revision !== legacy.command.expectedRevision : canonical(journal.value) !== canonical({ ...legacy.value, attachments: legacy.value.attachments ?? [] }))) throw Error('Two earlier Project drafts need review. Both original copies are preserved.');
      identity.legacy = legacySource(legacyRaw, id, legacyKey, journalKey(id), journal.epoch, true);
      identity.previousIndexRaw = raw;
      identity.indexRaw = JSON.stringify({ format: 1, id, legacy: { raw: legacyRaw, epoch: journal.epoch } });
    }
    return identity;
  }
  const legacyRaw = scope.space === 'chat' ? io.getItem(legacyKey) : null;
  const legacy = legacyRaw === null ? undefined : legacySchema.parse(JSON.parse(legacyRaw));
  if (legacy?.command && (legacy.command.kind !== 'project' || !projectId.safeParse(legacy.command.entityId).success)) throw Error('The kept Project command needs review. Its original writing is unchanged.');
  const id = legacy?.command?.entityId ?? `project:${crypto.randomUUID()}`;
  const identity: ProjectDraftIdentity = { id, indexKey, indexRaw: JSON.stringify(id), journalKey: journalKey(id) };
  if (legacy && legacyRaw !== null) {
    identity.legacy = legacySource(legacyRaw, id, legacyKey, journalKey(id), scope.epoch, false);
    identity.indexRaw = JSON.stringify({ format: 1, id, legacy: { raw: legacyRaw, epoch: scope.epoch } });
  }
  return identity;
}

/** Keep the original identity and legacy command before exposing an editable form. */
export function retainProjectDraftIdentity(identity: ProjectDraftIdentity, io = storage) {
  if (!identity.indexKey) {
    identity.initialJournal = { value: identity.journalKey ? readProjectJournal(identity.id, identity.journalKey, io) : undefined };
    return;
  }
  const current = io.getItem(identity.indexKey);
  if (current !== null && current !== identity.indexRaw && current !== identity.previousIndexRaw) throw Error('Another Project draft is kept here. Your current writing remains in this window.');
  if (identity.journalKey) readProjectJournal(identity.id, identity.journalKey, io);
  if (identity.legacy) {
    const source = identity.legacy;
    const journal = io.getItem(source.journalKey);
    if ((!source.resumed || journal === null) && io.getItem(source.key) !== source.raw) throw Error('The earlier Project writing changed. Reopen it before continuing.');
    if (!source.resumed && journal !== null && journal !== source.journalRaw) throw Error('This Project already has kept changes. Both original copies are preserved.');
    // Publish provenance first. A failed copy resumes the same original ID;
    // the retained pointer never mistakes a later editable journal for its source.
    if (current !== identity.indexRaw) io.setItem(identity.indexKey, identity.indexRaw!);
    if (io.getItem(identity.indexKey) !== identity.indexRaw) throw Error('This browser could not verify the Project draft location.');
    if (journal === null) io.setItem(source.journalKey, source.journalRaw);
    if ((!source.resumed || journal === null) && io.getItem(source.journalKey) !== source.journalRaw) throw Error('This browser could not verify the kept Project writing.');
  }
  if (current === null) io.setItem(identity.indexKey, identity.indexRaw!);
  if (io.getItem(identity.indexKey) !== identity.indexRaw) throw Error('This browser could not verify the Project draft location.');
  identity.initialJournal = { value: identity.journalKey ? readProjectJournal(identity.id, identity.journalKey, io) : undefined };
}

/** Retain the index on every departure without overwriting the evolving journal. */
export function retainProjectDraftLocation(identity: ProjectDraftIdentity, io = storage) {
  if (!identity.indexKey) return;
  const current = io.getItem(identity.indexKey);
  if (current !== null && current !== identity.indexRaw) throw Error('Another Project draft is kept here. Your current writing remains in this window.');
  if (current === null) io.setItem(identity.indexKey, identity.indexRaw!);
  if (io.getItem(identity.indexKey) !== identity.indexRaw) throw Error('This browser could not keep the Project draft location.');
}

/** Only discard our exact pointer and imported legacy copy after a confirmed save. */
export function finishProjectDraftIdentity(identity: ProjectDraftIdentity, io = storage) {
  if (identity.legacy && io.getItem(identity.legacy.key) === identity.legacy.raw) {
    io.removeItem(identity.legacy.key);
    if (io.getItem(identity.legacy.key) === identity.legacy.raw) throw Error('The Project is saved, but this browser could not finish keeping its draft.');
  }
  if (identity.indexKey && io.getItem(identity.indexKey) === identity.indexRaw) {
    io.removeItem(identity.indexKey);
    if (io.getItem(identity.indexKey) === identity.indexRaw) throw Error('The Project is saved, but this browser could not finish keeping its draft.');
  }
}
