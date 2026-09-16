export type DownloadProgress = { loadedBytes: number; totalBytes?: number; complete?: boolean; cached?: boolean };

export function downloadPercent(progress?: DownloadProgress): number | undefined {
  if (!progress) return undefined;
  if (progress.complete) return 100;
  if (!progress.totalBytes || progress.loadedBytes > progress.totalBytes) return undefined;
  return Math.min(99, Math.floor(progress.loadedBytes / progress.totalBytes * 100));
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function readDownload(response: Response, report: (progress: DownloadProgress) => void) {
  // Nova reports decoded UTF-8 bytes, so a proxy's gzip/br transfer size cannot
  // be mistaken for the larger chunks returned by browser fetch().
  const declared = response.headers.get('x-nova-body-bytes') ?? (!response.headers.get('content-encoding') ? response.headers.get('content-length') : null);
  const size = declared && /^\d+$/.test(declared) ? Number(declared) : undefined;
  let totalBytes = size && Number.isSafeInteger(size) ? size : undefined;
  let loadedBytes = 0;
  report({ loadedBytes, totalBytes });
  const reader = response.body?.getReader();
  if (!reader) return { text: '', loadedBytes: 0 };
  const decoder = new TextDecoder(); let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      loadedBytes += value.byteLength;
      if (totalBytes && loadedBytes > totalBytes) totalBytes = undefined;
      text += decoder.decode(value, { stream: true });
      report({ loadedBytes, totalBytes });
    }
    return { text: text + decoder.decode(), loadedBytes };
  } finally { reader.releaseLock(); }
}
