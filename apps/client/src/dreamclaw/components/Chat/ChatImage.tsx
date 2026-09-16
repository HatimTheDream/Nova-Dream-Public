import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X, ZoomIn, ZoomOut, RotateCw } from '@dreamclaw/components/icons';
import { saveInboxImage } from '../../inbox-host';
import { inboxI18n } from '../../inbox-i18n';

// ═══════════════════════════════════════════════════════════
// Original ImageLightbox extraction — verified Inbox attachment bytes only.
// ═══════════════════════════════════════════════════════════

// ── Resolve image source ──
// Handles different source formats from OpenClaw/Gateway
function resolveImageSrc(src: string): string { return /^(data:image\/|blob:)/.test(src) ? src : ''; }

// ── Extract filename from src ──
function extractFilename(src: string, alt?: string): string {
  if (alt && alt !== 'image' && alt !== 'attachment' && !alt.startsWith('http')) {
    // Sanitize alt as filename
    const sanitized = alt.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
    if (sanitized.match(/\.\w{2,4}$/)) return sanitized;
    return sanitized + '.png';
  }

  try {
    const url = new URL(src.startsWith('data:') ? 'file:///image.png' : src);
    const pathname = url.pathname;
    const name = pathname.split('/').pop();
    if (name && name.includes('.')) return name;
  } catch { /* ignore */ }

  return `image-${Date.now()}.png`;
}

// ── Save through the Edition 3 attachment boundary ──
const saveImage = saveInboxImage;

// ═══════════════════════════════════════════════════════════
// Lightbox (fullscreen image viewer)
// ═══════════════════════════════════════════════════════════

interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: LightboxProps) {
  const { t } = useTranslation(undefined, { i18n: inboxI18n });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saveError, setSaveError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog?.showModal();
    const zoomWithWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(value => Math.min(Math.max(value + (event.deltaY > 0 ? -0.15 : 0.15), 0.25), 5));
    };
    dialog?.addEventListener('wheel', zoomWithWheel, { passive: false });
    return () => { dialog?.removeEventListener('wheel', zoomWithWheel); dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  // Native dialog owns Escape, modal focus, and background interaction.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') setZoom(z => Math.min(z + 0.25, 5));
      if (e.key === '-') setZoom(z => Math.max(z - 0.25, 0.25));
      if (e.key === '0') { setZoom(1); setOffset({ x: 0, y: 0 }); setRotation(0); }
      if (e.key === 'r' || e.key === 'R') setRotation(r => r + 90);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Drag to pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetStart.current = { ...offset };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    setOffset({
      x: offsetStart.current.x + (e.clientX - dragStart.current.x),
      y: offsetStart.current.y + (e.clientY - dragStart.current.y),
    });
  };

  const handleMouseUp = () => setDragging(false);

  const handleSave = async () => {
    setSaveError('');
    try { await saveImage(resolveImageSrc(src), extractFilename(src, alt)); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'The image could not be downloaded.'); }
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-label={alt ? `Image preview: ${alt}` : 'Image preview'}
      className="dc-inbox-image-lightbox fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, background: 'var(--aegis-bg-frosted)', backdropFilter: 'blur(8px)' }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 h-12 flex items-center justify-between px-4 z-10"
        style={{ background: 'linear-gradient(to bottom, var(--aegis-bg-frosted-60), transparent)' }}>
        <span className="text-[12px] text-aegis-text-muted font-mono">
          {alt || 'Image'} — {Math.round(zoom * 100)}%
        </span>
        <div className="flex items-center gap-1">
          <button onClick={() => setZoom(z => Math.min(z + 0.25, 5))}
            className="p-2 rounded-lg hover:bg-[rgb(var(--aegis-overlay)/0.1)] text-aegis-text-secondary hover:text-aegis-text transition-all" title={t('image.zoomIn', 'Zoom in')}>
            <ZoomIn size={16} />
          </button>
          <button onClick={() => setZoom(z => Math.max(z - 0.25, 0.25))}
            className="p-2 rounded-lg hover:bg-[rgb(var(--aegis-overlay)/0.1)] text-aegis-text-secondary hover:text-aegis-text transition-all" title={t('image.zoomOut', 'Zoom out')}>
            <ZoomOut size={16} />
          </button>
          <button onClick={() => setRotation(r => r + 90)}
            className="p-2 rounded-lg hover:bg-[rgb(var(--aegis-overlay)/0.1)] text-aegis-text-secondary hover:text-aegis-text transition-all" title={t('image.rotate', 'Rotate')}>
            <RotateCw size={16} />
          </button>
          <div className="w-px h-5 bg-[rgb(var(--aegis-overlay)/0.1)] mx-1" />
          <button onClick={() => void handleSave()}
            className="p-2 rounded-lg hover:bg-[rgb(var(--aegis-overlay)/0.1)] text-aegis-text-secondary hover:text-aegis-text transition-all" title={t('image.save', 'Download image')}>
            <Download size={16} />
          </button>
          <div className="w-px h-5 bg-[rgb(var(--aegis-overlay)/0.1)] mx-1" />
          <button onClick={onClose}
            className="p-2 rounded-lg hover:bg-[rgb(var(--aegis-overlay)/0.1)] text-aegis-text-secondary hover:text-aegis-text transition-all" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Image */}
      <img
        src={resolveImageSrc(src)}
        alt={alt || ''}
        draggable={false}
        className="select-none transition-transform"
        style={{
          maxWidth: '90vw',
          maxHeight: 'calc(100dvh - 160px)',
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)`,
          cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
          transitionDuration: dragging ? '0ms' : '200ms',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />

      {/* Bottom hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-aegis-text-dim select-none">
        {saveError ? <span role="alert">{saveError}</span> : t('media.imageControls', 'Scroll to zoom · Drag to pan · Esc to close')}
      </div>
    </dialog>
  );
}
