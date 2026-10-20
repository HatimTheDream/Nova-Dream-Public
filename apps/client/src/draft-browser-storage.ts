/** Access storage inside each guarded reader/writer, including denied getters. */
export const draftBrowserStorage = {
  get length() { return localStorage.length; },
  key: (index: number) => localStorage.key(index),
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};
