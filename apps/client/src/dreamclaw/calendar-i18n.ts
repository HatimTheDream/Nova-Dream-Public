import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import translation from './calendar-en.json';

export const calendarI18n = createInstance();
export const calendarI18nReady = calendarI18n.use(initReactI18next).init({
  resources: { en: { translation } }, lng: 'en', fallbackLng: 'en',
  interpolation: { escapeValue: false }, initAsync: false,
});
