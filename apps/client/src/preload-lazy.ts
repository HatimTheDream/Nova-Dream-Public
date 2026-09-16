import { createElement, lazy as reactLazy, type ComponentType, type ComponentProps } from 'react';

export function createModuleRegistry() {
  const entries: { load(): Promise<unknown>; ready(): boolean }[] = [];
  function lazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
    let component: T | undefined, pending: Promise<{ default: T }> | undefined;
    const preload = () => pending ??= load().then(result => { component = result.default; return result; }).catch(error => { pending = undefined; throw error; });
    entries.push({ load: preload, ready: () => !!component });
    const Deferred = reactLazy(preload);
    return function PreparedModule(props: ComponentProps<T>) { return createElement(component ?? Deferred, props); };
  }
  async function prepare(report: (completed: number, total: number) => void = () => {}) {
    // Imported modules can register further lazy children. Finish every wave.
    for (;;) {
      const remaining = entries.filter(entry => !entry.ready());
      report(entries.length - remaining.length, entries.length);
      if (!remaining.length) return;
      await Promise.all(remaining.map(async entry => { await entry.load(); report(entries.filter(entry => entry.ready()).length, entries.length); }));
    }
  }
  return { lazy, prepare };
}
const registry = createModuleRegistry();
export const lazy = registry.lazy;
export const preloadModules = registry.prepare;
