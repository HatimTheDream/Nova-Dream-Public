import { z } from 'zod';
import { studioCommandSchema, studioCurationSchema, type StudioCuration, type StudioReceipt, type StudioState } from '../../packages/domain/profile-studio.js';
import { Fault, Store } from './store.js';

export const studioCurationKey = 'profile:studio:curation';
const questIdentity = z.object({ id: z.uuid(), revision: z.number().int().positive(), archived: z.boolean() }).passthrough();
export class ProfileStudio {
  constructor(private store: Store) {}
  private curation(): StudioCuration {
    const raw = this.store.internalRead<unknown>(studioCurationKey);
    if (raw === undefined) return { format: 1, revision: 0, questIds: [] };
    const parsed = studioCurationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.revision === 0) throw new Fault(409, 'studio_unreadable', 'Your saved Studio selection needs review. It has been kept unchanged.');
    return parsed.data;
  }
  private availability(id: string): 'available' | 'missing' | 'archived' {
    const raw = this.store.internalRead<unknown>('profile:quest:' + id);
    if (raw === undefined) return 'missing';
    const parsed = questIdentity.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) throw new Fault(409, 'studio_quest_unreadable', 'A selected quest cannot be verified. Its saved reference has been kept.');
    return parsed.data.archived ? 'archived' : 'available';
  }
  state(): StudioState {
    const curation = this.curation(), availableQuestIds: string[] = [], unavailable: StudioState['unavailable'] = [];
    for (const id of curation.questIds) {
      const reason = this.availability(id);
      if (reason === 'available') availableQuestIds.push(id); else unavailable.push({ id, reason });
    }
    return { epoch: this.store.epoch, curation, availableQuestIds, unavailable };
  }
  save(device: string, raw: unknown): StudioReceipt {
    const input = studioCommandSchema.parse(raw);
    this.store.assertUpdateAdmission();
    if (this.store.recoveryHeld) throw new Fault(409, 'recovery_held', 'Finish reviewing the recovered workspace before changing Studio.');
    return this.store.admit(device, input, { type: 'profile-studio', ...input }, () => {
      const old = this.curation();
      if (old.revision !== input.expectedRevision) throw new Fault(409, 'studio_changed', 'Your Studio selection changed in another window. Review the saved selection before saving.');
      for (const id of input.questIds) if (this.availability(id) !== 'available') throw new Fault(409, 'studio_quest_changed', 'A selected quest is unavailable or archived. Review your choices before saving.');
      const curation: StudioCuration = { format: 1, revision: old.revision + 1, questIds: input.questIds };
      this.store.internalWrite(studioCurationKey, curation);
      return { requestId: input.requestId, epoch: input.epoch, curation };
    }).value;
  }
}
