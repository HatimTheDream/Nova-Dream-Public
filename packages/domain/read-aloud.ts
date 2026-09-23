export const speechTextLimit = 1800;
export const speechAudioLimit = 8 * 1024 * 1024;
export type SpeechCatalog = {
  state: 'available' | 'unavailable';
  epoch: string;
  message: string;
  provider?: string;
  providerLabel?: string;
};
export type SpeechAudio = { audioBase64: string; mimeType: string; provider: string };
