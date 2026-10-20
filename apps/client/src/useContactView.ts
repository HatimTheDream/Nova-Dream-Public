import { useRef, useState } from 'react';
import { readLocal, saveLocal } from './api';

/** Presentation only. Form drafts and pending commands keep their existing journals. */
export function useContactView<T extends object>(key: string, defaults: T) {
  const [view, setView] = useState<T>(() => ({ ...defaults, ...readLocal<Partial<T>>(key) }));
  const current = useRef(view);
  const [error, setError] = useState('');
  const prefer = (patch: Partial<T>) => {
    const next = { ...current.current, ...patch };
    current.current = next; setView(next);
    const saved = saveLocal(key, next);
    setError(saved ? '' : 'This view is kept in the current window only.');
    return saved;
  };
  return { view, prefer, error };
}
