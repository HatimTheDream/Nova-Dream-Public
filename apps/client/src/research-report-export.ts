import type { AssistantOperation } from '../../../packages/domain/assistant';

/** Read a displayed heading without treating a code example as the report title. */
export function researchReportTitle(text: string, fallback?: string): string {
  let fence: { character: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) return heading.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').trim().slice(0, 180) || 'Research report';
  }
  return fallback?.trim().slice(0, 180) || 'Research report';
}

export function researchReportElapsed(operation?: Pick<AssistantOperation, 'state' | 'createdAt' | 'updatedAt' | 'settledAt'>): string | undefined {
  if (operation?.state !== 'completed') return undefined;
  const start = Date.parse(operation.createdAt), end = Date.parse(operation.settledAt ?? operation.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor((end - start) / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/** The original Markdown is exported unchanged, never converted to executable HTML. */
export function researchReportExport(text: string, title?: string) {
  let name = researchReportTitle(text, title).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'Research report';
  return { name: `${name}.md`, text, mimeType: 'text/markdown;charset=utf-8' };
}
