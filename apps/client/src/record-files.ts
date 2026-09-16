import type { Content } from '../../../packages/domain/workspace-records';

// Nova CoreModulePage's real Blob export, adapted for a specific saved E3 revision.
export function contentFile(value: Content, revision: number) {
  const stem = value.title.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'draft';
  return { name: `${stem}-v${revision}.${value.format === 'markdown' ? 'md' : 'txt'}`, type: value.format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8', body: value.body };
}
export function exportContent(value: Content, revision: number) {
  const file = contentFile(value, revision);
  const url = URL.createObjectURL(new Blob([file.body], { type: file.type }));
  const link = document.createElement('a'); link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
