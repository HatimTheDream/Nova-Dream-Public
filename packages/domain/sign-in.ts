export type ChatGptSignInMethod = 'browser' | 'device-code';
export type ChatGptSignInStatus = {
  id?: string;
  method?: ChatGptSignInMethod;
  state: 'idle' | 'starting' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  message: string;
  expiresAt?: number;
  verificationUrl?: string;
  userCode?: string;
  authorizationUrl?: string;
};
export type ChatGptAccountStatus = {
  state: 'available' | 'empty' | 'unavailable';
  emails: string[];
  profileCount: number;
  message: string;
};
