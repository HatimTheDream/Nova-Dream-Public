import { canonical, moduleIds, type ModuleId } from '../../../packages/domain/contracts';
import type { AssistantSpace } from '../../../packages/domain/assistant-space';
import type { SettingsTab } from './SettingsPage';

type Scope = { epoch: string; deviceId: string; windowId: string };
export type SetupJourney = { format: 1; scope: Scope; origin: ModuleId; section: SettingsTab; token: string;
  selection?: { id: string | null; space: AssistantSpace } };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const sections = ['index', 'general', 'accounts', 'assistant', 'usage', 'phone', 'data', 'updates'];
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
function valid(value: unknown, scope: Scope): value is SetupJourney {
  if (!value || typeof value !== 'object') return false;
  const item = value as SetupJourney;
  return item.format === 1 && canonical(item.scope) === canonical(scope) && moduleIds.includes(item.origin)
    && sections.includes(item.section) && bounded(item.token) && (item.origin !== 'assistant'
      ? item.selection === undefined
      : !!item.selection && (item.selection.id === null || bounded(item.selection.id)) && ['chat', 'work'].includes(item.selection.space));
}

/** Metadata only. Writing and attachments remain with their existing journals. */
export class SetupJourneyJournal {
  readonly key: string;
  value?: SetupJourney;
  error = '';
  private raw: string | null = null;
  private invalid = false;
  private attempted?: string;
  constructor(private storage: Storage, readonly scope: Scope) {
    this.key = `e3:setup-return:${canonical(scope)}`;
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw !== null) {
        if (this.raw.length > 4096) throw Error();
        const value: unknown = JSON.parse(this.raw);
        if (value !== null && !valid(value, scope)) throw Error();
        this.value = value ?? undefined;
      }
    } catch { this.invalid = true; this.error = 'The original setup return could not be read. Its stored copy is kept.'; }
  }
  keep(value: SetupJourney | undefined): boolean {
    try {
      if (this.invalid || value !== undefined && !valid(value, this.scope)) throw Error();
      const before = this.storage.getItem(this.key), next = canonical(value ?? null);
      if (before !== this.raw && !(before === this.attempted && before === next)) throw Error();
      this.attempted = next;
      this.storage.setItem(this.key, next);
      if (this.storage.getItem(this.key) !== next) throw Error();
      this.raw = next; this.value = value; this.attempted = undefined; this.error = ''; return true;
    } catch { this.error = 'Keep this window open. The exact setup return could not be retained; the current work is still here.'; return false; }
  }
  matchesSelection(id: string | null, space: AssistantSpace) {
    return this.value?.origin !== 'assistant' || this.value.selection?.id === id && this.value.selection.space === space;
  }
}

export type SetupPosition = { focus: HTMLElement | null; selection?: [number | null, number | null, 'forward' | 'backward' | 'none' | null];
  scroll: { node: HTMLElement; top: number; left: number }[] };
export function captureSetupPosition(root: HTMLElement | null, focus: HTMLElement | null): SetupPosition {
  const target = focus && root?.contains(focus) ? focus : null;
  const editable = target as HTMLTextAreaElement | null;
  return { focus: target, ...(editable && (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT')
    ? { selection: [editable.selectionStart, editable.selectionEnd, editable.selectionDirection] as SetupPosition['selection'] } : {}),
    scroll: root ? [root, ...root.querySelectorAll<HTMLElement>('.page-scroll, .conversation-reading, .conversation-scroll-region, textarea')]
      .map(node => ({ node, top: node.scrollTop, left: node.scrollLeft })) : [] };
}
export function restoreSetupPosition(position: SetupPosition) {
  const target = position.focus;
  if (target?.isConnected) {
    target.focus({ preventScroll: true });
    if (position.selection) {
      const [start, end, direction] = position.selection;
      if (start !== null && end !== null) try { (target as HTMLTextAreaElement).setSelectionRange(start, end, direction ?? undefined); } catch { /* Non-text inputs have no caret. */ }
    }
  }
  for (const { node, top, left } of position.scroll) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
}
