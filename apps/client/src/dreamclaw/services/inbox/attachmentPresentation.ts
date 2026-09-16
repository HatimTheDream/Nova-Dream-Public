export type InboxAttachmentKind =
  | 'archive'
  | 'audio'
  | 'code'
  | 'document'
  | 'image'
  | 'pdf'
  | 'presentation'
  | 'spreadsheet'
  | 'video'
  | 'file';

export interface InboxAttachmentDescriptor {
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface InboxAttachmentSummary {
  count: number;
  countLabel: string;
  sizeLabel: string;
}

export interface InboxAttachmentAvailability {
  canOpen: boolean;
  canDownload: boolean;
  openVerb: 'Open' | 'Preview';
  status: string | null;
  disabledReason: string | null;
}

function normalizedExtension(name?: string): string {
  const match = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]{1,12})$/);
  return match?.[1] || '';
}

export function formatInboxAttachmentSize(size?: number): string {
  if (!Number.isFinite(size) || !size || size <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function describeInboxAttachment(
  attachment: InboxAttachmentDescriptor,
): { kind: InboxAttachmentKind; typeLabel: string } {
  const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
  const extension = normalizedExtension(attachment.name);

  if (mimeType === 'application/pdf' || extension === 'pdf') return { kind: 'pdf', typeLabel: 'PDF' };
  if (mimeType.startsWith('image/')) {
    const imageLabel = mimeType === 'image/jpeg' ? 'JPEG image'
      : mimeType === 'image/png' ? 'PNG image'
        : mimeType === 'image/gif' ? 'GIF image'
          : mimeType === 'image/svg+xml' ? 'SVG image'
            : 'Image';
    return { kind: 'image', typeLabel: imageLabel };
  }
  if (mimeType.startsWith('audio/')) return { kind: 'audio', typeLabel: 'Audio file' };
  if (mimeType.startsWith('video/')) return { kind: 'video', typeLabel: 'Video file' };
  if (['doc', 'docx', 'rtf', 'odt'].includes(extension)
    || mimeType === 'application/msword'
    || mimeType.includes('wordprocessingml')
    || mimeType.includes('opendocument.text')) {
    return { kind: 'document', typeLabel: extension === 'rtf' ? 'Rich text document' : 'Word document' };
  }
  if (['xls', 'xlsx', 'ods', 'csv'].includes(extension)
    || mimeType.includes('spreadsheetml')
    || mimeType.includes('ms-excel')
    || mimeType.includes('opendocument.spreadsheet')
    || mimeType === 'text/csv') {
    return { kind: 'spreadsheet', typeLabel: extension === 'csv' || mimeType === 'text/csv' ? 'CSV spreadsheet' : 'Excel spreadsheet' };
  }
  if (['ppt', 'pptx', 'odp'].includes(extension)
    || mimeType.includes('presentationml')
    || mimeType.includes('ms-powerpoint')
    || mimeType.includes('opendocument.presentation')) {
    return { kind: 'presentation', typeLabel: 'PowerPoint presentation' };
  }
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(extension)
    || mimeType.includes('zip')
    || mimeType.includes('compressed')
    || mimeType.includes('archive')) {
    return { kind: 'archive', typeLabel: 'Archive' };
  }
  if (['js', 'jsx', 'ts', 'tsx', 'json', 'html', 'css', 'xml', 'yaml', 'yml', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sh'].includes(extension)
    || mimeType.includes('json')
    || mimeType.includes('javascript')
    || mimeType.includes('xml')) {
    return { kind: 'code', typeLabel: 'Code file' };
  }
  if (mimeType.startsWith('text/') || ['txt', 'md'].includes(extension)) return { kind: 'document', typeLabel: 'Text document' };
  return { kind: 'file', typeLabel: 'File' };
}

export function summarizeInboxAttachments(
  attachments: readonly InboxAttachmentDescriptor[],
): InboxAttachmentSummary {
  const knownSizes = attachments
    .map((attachment) => attachment.size)
    .filter((size): size is number => Number.isFinite(size) && Number(size) > 0);
  const knownBytes = knownSizes.reduce((total, size) => total + size, 0);
  const formattedSize = formatInboxAttachmentSize(knownBytes);
  return {
    count: attachments.length,
    countLabel: `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`,
    sizeLabel: formattedSize
      ? `${formattedSize} ${knownSizes.length === attachments.length ? 'total' : 'known'}`
      : '',
  };
}

export function getInboxAttachmentAvailability(options: {
  allowExternalContent: boolean;
  hasData: boolean;
  isImage: boolean;
  hasImagePreview: boolean;
}): InboxAttachmentAvailability {
  const openVerb = options.isImage ? 'Preview' : 'Open';
  if (!options.allowExternalContent) {
    return {
      canOpen: false,
      canDownload: false,
      openVerb,
      status: 'Unavailable during safe review',
      disabledReason: 'Attachment actions are disabled during safe review.',
    };
  }

  const canOpen = options.isImage ? options.hasImagePreview : options.hasData;
  if (!options.hasData) {
    return {
      canOpen: false,
      canDownload: false,
      openVerb,
      status: 'Unavailable from this provider',
      disabledReason: 'Attachment bytes are unavailable from this provider.',
    };
  }

  return {
    canOpen,
    canDownload: true,
    openVerb,
    status: canOpen ? null : 'Preview unavailable',
    disabledReason: canOpen ? null : 'This attachment cannot be previewed.',
  };
}
