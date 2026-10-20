import { z } from 'zod';
import { canonical, type Snapshot } from '../../../packages/domain/contracts';
import { questCommandSchema, questDraftSchema, type PersonalQuest, type QuestDraft } from '../../../packages/domain/profile-progression';
import { readProfileSlot, writeProfileSlot, type ProfileSlot, type ProfileStorage } from './profile-kept-state';

const writing = z.object({
  id: z.uuid(), title: z.string(), description: z.string(), projectId: z.string().nullable(), due: z.string(),
  steps: z.array(z.object({ id: z.uuid(), taskId: z.string().nullable(), title: z.string() }).strict()),
}).strict();
const journalShape = z.object({ draft: writing, revision: z.number().int().min(0), epoch: z.uuid(), pending: z.unknown().optional(), dirty: z.boolean() }).strict();
export type QuestSave = Extract<z.infer<typeof questCommandSchema>, { action: 'save' }>;
export type QuestJournal = { draft: QuestDraft; revision: number; epoch: string; pending?: QuestSave; dirty: boolean };
export type QuestScope = { id: string; epoch: string; device: string };
const responseShape = z.object({
  id: z.uuid(), title: z.string(), description: z.string(), projectId: z.string().nullable(), due: z.string(),
  steps: z.array(z.object({ id: z.uuid(), taskId: z.string() }).strict()),
  revision: z.number().int().min(1), archived: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Keep this window open until the original save is confirmed.';

export function questWriting(quest: PersonalQuest, snapshot: Snapshot): QuestDraft {
  return { id: quest.id, title: quest.title, description: quest.description, projectId: quest.projectId, due: quest.due,
    steps: quest.steps.map(step => ({ ...step, title: [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].find(task => task.id === step.taskId)?.value.title ?? 'Task unavailable' })) };
}
export function isQuestJournal(value: unknown, id: string): value is QuestJournal {
  const parsed = journalShape.safeParse(value);
  if (!parsed.success || parsed.data.draft.id !== id) return false;
  if (parsed.data.pending === undefined) return true;
  const pending = questCommandSchema.safeParse(parsed.data.pending);
  return pending.success && pending.data.action === 'save' && pending.data.quest.id === id &&
    pending.data.epoch === parsed.data.epoch && pending.data.expectedRevision === parsed.data.revision;
}
export function confirmedQuest(input: QuestSave, value: unknown): PersonalQuest {
  const command = questCommandSchema.parse(input);
  if (command.action !== 'save') throw Error('This is not the original quest save.');
  const result = responseShape.parse(value), expected = command.quest;
  const steps = expected.steps.map(step => ({ id: step.id, taskId: step.taskId ?? `task:quest:${expected.id}:${step.id}` }));
  if (result.id !== expected.id || result.revision !== command.expectedRevision + 1 || result.archived ||
    canonical({ title: result.title, description: result.description, projectId: result.projectId, due: result.due, steps: result.steps }) !==
    canonical({ title: expected.title, description: expected.description, projectId: expected.projectId, due: expected.due, steps })) {
    throw Error('The response does not confirm this original quest and its Task links. Check the same save.');
  }
  return result;
}

/** The legacy per-window journal stays the only durable writing/request owner. */
export class QuestEditor {
  journal: QuestJournal;
  slot: ProfileSlot<QuestJournal | null>;
  error = '';
  conflict = false;
  busy = false;
  active = true;
  private discarded = false;
  private outcome?: { command: QuestSave; result: PersonalQuest } | { command: QuestSave; rejection: string; conflict: boolean };
  constructor(private storage: ProfileStorage, readonly key: string, readonly scope: QuestScope, private fallback: QuestJournal,
    private post: (input: QuestSave) => Promise<unknown>, private notify: () => void = () => {}, private owns: () => boolean = () => true) {
    this.slot = readProfileSlot(storage, key, fallback, (value): value is QuestJournal | null => value === null || isQuestJournal(value, scope.id));
    const kept = this.slot.value;
    this.journal = kept && (kept.dirty || kept.pending) ? kept : fallback;
    if (this.slot.invalid) this.error = 'The original quest writing cannot be verified. It remains untouched in this browser.';
  }
  private current() { return this.active && this.owns(); }
  get kept() { return this.slot.raw === JSON.stringify(this.journal); }
  private emit() { if (this.current()) this.notify(); }
  private persist(next: QuestJournal | null) {
    if (!this.current()) return false;
    try {
      this.slot = writeProfileSlot(this.storage, this.slot, next);
      if (next) this.journal = next;
      this.error = ''; this.emit(); return true;
    } catch (reason) { this.error = message(reason); this.emit(); return false; }
  }
  retire() { this.active = false; }
  retain() {
    if (!this.current()) return true;
    if (this.discarded) return true;
    if (this.slot.invalid) return true; // No editable fallback was admitted over unknown original bytes.
    return this.persist(this.journal);
  }
  change(draft: QuestDraft) {
    if (!this.current() || this.slot.invalid || this.busy || this.journal.pending) return false;
    this.discarded = false; this.journal = { ...this.journal, draft, dirty: true };
    this.emit(); return this.persist(this.journal);
  }
  changed(quest?: PersonalQuest) { return this.journal.epoch !== this.scope.epoch || this.journal.revision !== (quest?.revision ?? 0); }
  sync(quest: PersonalQuest | undefined, snapshot: Snapshot) {
    if (!this.current() || this.slot.invalid || this.journal.dirty || this.journal.pending || !quest || snapshot.epoch !== this.scope.epoch) return;
    if (quest.revision !== this.journal.revision) this.persist({ draft: questWriting(quest, snapshot), revision: quest.revision, epoch: snapshot.epoch, dirty: false });
  }
  review(quest?: PersonalQuest) {
    if (!this.current() || this.slot.invalid || this.busy || this.journal.pending || this.journal.epoch !== this.scope.epoch ||
      quest?.archived || (!quest && this.journal.revision > 0)) return false;
    if (!this.persist({ ...this.journal, revision: quest?.revision ?? 0, dirty: true })) return false;
    this.conflict = false; this.emit(); return true;
  }
  discard() {
    if (!this.current() || this.slot.invalid || this.busy || this.journal.pending) return false;
    if (!this.persist(null)) return false;
    this.discarded = true; this.journal = this.fallback; this.emit(); return true;
  }
  private settle(): PersonalQuest | undefined {
    const outcome = this.outcome;
    if (!outcome || !this.current() || canonical(this.journal.pending) !== canonical(outcome.command)) return;
    if ('rejection' in outcome) {
      if (!this.persist({ ...this.journal, pending: undefined })) return;
      this.outcome = undefined; this.error = outcome.rejection; this.conflict = outcome.conflict; this.emit(); return;
    }
    const result = outcome.result, original = outcome.command.quest;
    // The input is disabled while pending; an independently changed journal fails CAS.
    const draft = { ...original, title: result.title, steps: result.steps.map((step, i) => ({ ...step, title: original.steps[i].title })) };
    if (!this.persist({ draft, revision: result.revision, epoch: outcome.command.epoch, dirty: false })) return;
    this.outcome = undefined; this.conflict = false; return result;
  }
  async save(quest?: PersonalQuest): Promise<PersonalQuest | undefined> {
    if (!this.current() || this.busy || this.slot.invalid) return;
    if (this.journal.epoch !== this.scope.epoch) { this.error = 'This writing belongs to the previous workspace. Its original save is preserved.'; this.emit(); return; }
    if (this.outcome) return this.settle();
    if (!this.journal.dirty && !this.journal.pending && this.journal.revision > 0) return;
    if (!this.journal.pending && (this.changed(quest) || this.conflict || quest?.archived || !quest && this.journal.revision > 0)) {
      this.error = 'Review the current quest before saving your kept writing.'; this.emit(); return;
    }
    if (!this.journal.pending) {
      const checked = questDraftSchema.safeParse(this.journal.draft);
      if (!checked.success) { this.error = checked.error.issues.map(issue => issue.message).join(' '); this.emit(); return; }
      this.journal = { ...this.journal, pending: { action: 'save', quest: structuredClone(this.journal.draft), expectedRevision: this.journal.revision, epoch: this.journal.epoch, requestId: crypto.randomUUID() } };
    }
    const command = this.journal.pending!;
    if (!this.persist(this.journal)) return;
    this.busy = true; this.emit();
    try {
      const response = await this.post(command);
      if (!this.current()) return;
      const result = confirmedQuest(command, response);
      this.outcome = { command, result };
      return this.settle();
    } catch (reason) {
      if (!this.current()) return;
      this.error = message(reason);
      const status = reason && typeof reason === 'object' && 'status' in reason ? reason.status : undefined;
      if (!this.outcome && typeof status === 'number' && status >= 400 && status < 500) {
        this.outcome = { command, rejection: this.error, conflict: status === 409 }; this.settle();
      }
      this.emit();
    } finally { this.busy = false; this.emit(); }
  }
}
