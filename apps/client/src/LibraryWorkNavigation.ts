import { createContext, useContext } from 'react';
import type { LibraryWorkOrigin } from './library-work-draft';

/** Module transitions go through the shell so the current editor can keep its writing. */
export type LibraryWorkNavigation = {
  openWork: (assignmentId: string, attemptId?: string) => boolean;
  openLibrary: (origin: LibraryWorkOrigin) => boolean;
  openDraft: (id: string) => boolean;
};

export const LibraryWorkRoutes = createContext<LibraryWorkNavigation | null>(null);
export function useLibraryWorkRoutes() {
  return useContext(LibraryWorkRoutes);
}
