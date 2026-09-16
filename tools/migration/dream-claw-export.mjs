// Controlled browser-storage export for fixed DC 0.57.2. Call in the original
// app's browser context; this function only reads the allowlisted app records.
// Native data and authentication remain with their original owners.
export function prepareDreamClawExport(storage, { version, storeId, timezone, createdAt = new Date().toISOString() }) {
  if (version !== '0.57.2') throw new Error('Inspect this version before adding an export adapter.');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(storeId)) throw new Error('Use a stable UUID for this source workspace.');
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  const keys = [
    'dream-claw-workshop-tasks', 'dream-claw-mission-control-v1',
    'dream-claw-home-widget-layout-v2', 'dream-claw-home-widget-layout-v1',
    'dream-claw-assistant-organization-v1', 'dream-claw-assistant-continuity-v2',
    'dream-claw-progression-v1', 'dream-claw-calendar-events', 'dream-claw-calendar-settings',
    'dream-claw-theme', 'dream-claw-accent-color', 'dream-claw-page-view-state-v1',
    'dream-claw-task-runs-v1', 'dream-claw-workflow-runs-v1', 'dream-claw-voice-live',
  ];
  const exported = {};
  for (const key of keys) { const value = storage.getItem(key); if (value !== null) exported[key] = value; }
  return { format: 'dream-claw-storage-1', appVersion: version, storeId, createdAt, timezone, storage: exported };
}
