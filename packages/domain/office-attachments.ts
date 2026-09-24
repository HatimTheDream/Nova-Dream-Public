export const officeAttachmentMimeTypes = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
export type OfficeKind = keyof typeof officeAttachmentMimeTypes;
export function officeAttachmentKind(name: string): OfficeKind | undefined {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return Object.hasOwn(officeAttachmentMimeTypes, extension) ? extension as OfficeKind : undefined;
}
