import { Fault } from './store.js';

type NativePage = Record<string, any>;
const meta = (message: any) => message?.__openclaw ?? {};
const nativeId = (page: NativePage) => page.sessionId ?? page.sessionInfo?.sessionId;
/** Exact-message reads omit pagination on OpenClaw. Find a verified ordinary page
 * by sequence, rather than treating a transcript sequence as a raw record offset. */
export async function locateHistoryPosition(anchored: NativePage, messageId: string, read: (offset: number) => Promise<NativePage>): Promise<NativePage> {
  if (Number.isSafeInteger(anchored.offset)) return anchored;
  const wanted = anchored.messages?.find((message: any) => meta(message).id === messageId || message.id === messageId);
  if (!wanted) return anchored;
  const target = meta(wanted), session = nativeId(anchored), source = target.transcriptPosition?.source;
  const check = (page: NativePage) => {
    if (nativeId(page) !== session) throw new Fault(409, 'session_replaced', 'The original conversation changed while restoring your reading position.');
    return page.messages?.some((message: any) => meta(message).id === messageId || message.id === messageId);
  };
  const head = await read(0);
  if (check(head)) return head;
  if (!Number.isSafeInteger(target.seq) || !Number.isSafeInteger(head.totalMessages)) throw new Fault(409, 'history_position_unavailable', 'This host cannot locate the saved reading position. Open Latest to continue.');
  let low = 1, high = head.totalMessages - 1;
  const deadline = Date.now() + 8000;
  for (let count = 0; count < 16 && low <= high && Date.now() < deadline; count++) {
    const offset = Math.floor((low + high) / 2), page = await read(offset);
    if (page.totalMessages !== head.totalMessages) throw new Fault(409, 'history_position_changed', 'New messages arrived while restoring your reading position. Try again.');
    if (check(page)) return page;
    const records = (page.messages ?? []).map(meta).filter((value: any) => Number.isSafeInteger(value.seq));
    if (!records.length || records.some((value: any) => source !== undefined && value.transcriptPosition?.source !== source)) break;
    const first = records[0].seq, last = records.at(-1).seq;
    if (target.seq < first) low = offset + 1;
    else if (target.seq > last) high = offset - 1;
    else break; // The id disappeared within its sequence range; never substitute a nearby message.
  }
  throw new Fault(409, 'history_position_unavailable', 'The saved message is not in the current transcript. Open Latest, or find the original message in chat search.');
}
