import { createInstance } from 'i18next';

// Original image controls, scoped to Inbox so it can load before Calendar.
export const inboxI18n = createInstance();
void inboxI18n.init({ lng: 'en', fallbackLng: 'en', initAsync: false,
  interpolation: { escapeValue: false }, resources: { en: { translation: {
    image: { zoomIn: 'Zoom in', zoomOut: 'Zoom out', rotate: 'Rotate', save: 'Download image' },
    media: { imageControls: 'Scroll to zoom · Drag to pan · R to rotate · 0 to reset · Esc to close' },
  } } },
});
