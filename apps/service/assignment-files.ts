import { isBinarySource, readableSourceLimit } from '../../packages/domain/source-reader.js';
import type { AssignmentCapture } from '../../packages/domain/assignments.js';
import type { Attachment } from '../../packages/domain/contracts.js';
import { canonical } from '../../packages/domain/contracts.js';
import type { Content } from '../../packages/domain/workspace-records.js';
import { Fault, Store } from './store.js';

export const assignmentFileLimit = 64 * 1024, assignmentFileTotal = 128 * 1024;
/** Inline complete text and retain exact binary identities for the bounded
 * source tools. Metadata never claims that a file has already been read. */
export function captureAssignmentFiles(store: Store, capture: AssignmentCapture): NonNullable<AssignmentCapture['files']> {
  const candidates = [
    ...(capture.project?.value.attachments ?? []).map(file => ({ file, origin: `Project: ${capture.project!.value.name}` })),
    ...capture.sources.filter(source => source.kind === 'content').flatMap(source => ((source.record.value as Content).assets ?? []).map(file => ({ file, origin: `Content: ${(source.record.value as Content).title} · v${source.record.revision}` }))),
  ];
  const unique = new Map<string, { file: Attachment; origins: string[] }>();
  for (const candidate of candidates) {
    const previous = unique.get(candidate.file.id);
    if (previous && canonical(previous.file) !== canonical(candidate.file)) throw new Fault(409, 'assignment_file_changed', 'A source file has conflicting identities. Review the selected saved sources.');
    if (previous) previous.origins.push(candidate.origin); else unique.set(candidate.file.id, { file: candidate.file, origins: [candidate.origin] });
  }
  let bytes = 0, binaryBytes = 0;
  return [...unique.values()].flatMap(item => {
    if (isBinarySource(item.file.name)) {
      binaryBytes += item.file.size;
      if (item.file.size > readableSourceLimit || binaryBytes > 24 * 1024 * 1024 || (capture.binaryFiles?.length ?? 0) >= 12) throw new Fault(413, 'assignment_input_large', 'Binary sources support up to 8 MB each, 24 MB total and 12 files per assignment. Nothing was dispatched.');
      const saved = store.download(item.file.id);
      if (canonical(saved.metadata) !== canonical(item.file)) throw new Fault(409, 'assignment_file_changed', 'A captured source file changed before the assignment could start.');
      (capture.binaryFiles ??= []).push(item); return [];
    }
    if(capture.plan.value.executionMode==='proposal'&&!/\.(txt|md|csv|json)$/i.test(item.file.name)){
      (capture.omittedFiles??=[]).push({file:item.file,reason:'Binary attachment retained for owner review; its contents were not supplied to the text worker.'});return [];
    }
    if (!/\.(txt|md|csv|json)$/i.test(item.file.name)) throw new Fault(409, 'assignment_file_unsupported', `This worker can read complete TXT, Markdown, CSV and JSON sources. ${item.file.name} needs a supported text source before this assignment can run.`);
    if (item.file.size > assignmentFileLimit || bytes + item.file.size > assignmentFileTotal) throw new Fault(413, 'assignment_input_large', 'Assignment source files support up to 64 KB each and 128 KB total. Nothing was truncated or dispatched.');
    let text: string;
    try { const saved = store.download(item.file.id); if (canonical(saved.metadata) !== canonical(item.file)) throw new Error(); text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(saved.bytes); if (text.includes('\0')) throw new Error(); }
    catch { throw new Fault(409, 'assignment_file_changed', 'A source file could not be read as complete UTF-8 text. Review its original saved bytes.'); }
    bytes += item.file.size;
    return [{ ...item, text }];
  });
}
