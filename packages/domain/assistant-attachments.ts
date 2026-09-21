/** Formats the existing Assistant transport can supply to the native runtime.
 * This is a send contract, not a restriction on keeping original workspace files. */
export const assistantAttachmentMimeTypes = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
} as const;
export const assistantAttachmentAccept = Object.keys(assistantAttachmentMimeTypes).map(extension => `.${extension}`).join(',');
export const assistantAttachmentLimit = 8 * 1024 * 1024;
export function assistantAttachmentMime(name: string): string | undefined {
  if (!name.includes('.')) return undefined;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(assistantAttachmentMimeTypes, extension) ? assistantAttachmentMimeTypes[extension as keyof typeof assistantAttachmentMimeTypes] : undefined;
}

type AssistantFile = { name: string; size?: number };
export function assistantAttachmentIssue(file: AssistantFile): string | undefined {
  if (!assistantAttachmentMime(file.name)) return `${file.name} cannot be sent to Assistant yet. Use TXT, Markdown, JSON, CSV, PDF, PNG, JPEG or WebP. Your draft and saved files are kept.`;
  if (file.size !== undefined && file.size > assistantAttachmentLimit) return `${file.name} exceeds Assistant’s 8 MB file limit. Your draft and saved files are kept.`;
}
export function assistantAttachmentsIssue(files: readonly AssistantFile[]): string | undefined {
  for (const file of files) { const issue = assistantAttachmentIssue(file); if (issue) return issue; }
}
