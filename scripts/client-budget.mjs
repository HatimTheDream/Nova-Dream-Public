import assert from 'node:assert/strict';

// Keep the original 180 KB startup ceiling and 80 KB per deferred chunk.
// 0.32 restores DC's virtualized transcript and the connected Assistant controls.
// Assistant now loads on demand: measured startup falls from 139,803 to 127,157
// gzip bytes, while the full client grows to 417,523 bytes. Bound that added
// capability at 430 KB; startup and individual deferred-chunk limits stay fixed.
// See docs/edition-3/38-ASSISTANT-UI-REVIEW.md for the measured tradeoff.
// 0.37 adds retained Project sources and captured-source inspection: measured
// total 432,762 (+3,071, 0.7%). Project editing stays lazy-loaded. Allow 435 KB
// total while preserving both startup and per-chunk ceilings; see milestone 49.
// 0.40 adds an on-demand memory editor and scoped, captured-memory views.
// Measured total 437,076 (+3,071, 0.71%); editor chunk 2,490 gzip bytes.
// Bound total at 440 KB; startup and per-chunk limits remain unchanged.
// 0.42 adds browser-owned dictation, retained native Goal controls, and real plan
// progress. Measured total 441,175 (+3,448 over 0.41, 0.79%); startup remains
// 130,509 and every deferred chunk stays under 80 KB. Bound this tranche at 445 KB.
// 0.47.3 restores message image display and bounded, account-scoped loading.
// Measured total 445,211 (+836, 0.19%). Keep startup/chunk limits; cap total at 446 KB.
// 0.48 adds bounded startup mail warming and complete-message reveal (+493 bytes
// in the first coherent build). Retain startup/chunk limits; cap total at447 KB.
// 0.48.2 adds visible-opening read updates and saved response recovery.
// Measured 447,242 bytes; retain startup/chunk ceilings and bound total at 448 KB.
// 0.48.6 restores automatic Calendar sync and individual source visibility.
// Measured total 448,550 (+937, 0.21%); retain startup/chunk ceilings; cap at 449 KB.
// 0.49 adds task batch recovery/undo, Trash, full history and search.
// After removing Focus: 453,322 total (+4,772, 1.06%). Tasks loads on demand.
// Bound the tranche at 455 KB; retain the startup and deferred-chunk ceilings.
// 0.50 connects Tasks and Calendar recurrence through shared projections.
// Measured 456,353 total (+3,420, 0.75%); retain startup/chunk limits.
// 0.52 adds shared, on-demand Assistant suggestions and event subtask details.
// Measured 461,136 total (+3,234, 0.71%); retain startup/chunk limits.
// 0.52.3 replaces the Tasks filter form with checked pickers and active labels.
// Measured total 462,570 (+1,115, 0.24%); bound total at463 KB.
// The shared disclosure preserves keyboard focus; startup/chunk limits stay fixed.
// 0.53 adds the on-demand Contacts directory, duplicate review and Inbox discovery.
// First coherent build: 472,493 total (+9,605, 2.08%); preserve startup/chunk ceilings.
// Bound this capability tranche at 475 KB.
// 0.55 adds lazy CRM profiles, organization pages, pipeline and provider sync review.
// First measured total 481,732 bytes (+7,535); retain startup and chunk ceilings.
// 0.57 adds separate Assistant spaces and a real tool-observation panel.
// First measured total 485,617 (+1,900); keep startup/chunk ceilings, cap total at 488 KB.
// 0.57.2 adds verified file previews and compact space-specific context summaries.
// Measured total 489,978 (+2,445, 0.50%); keep startup/chunk ceilings; cap at492 KB.
// 0.57.3 adds retained workspace tabs and compact summary/menu navigation.
// Measured total 492,342 (+1,699, 0.35%); bound total at493 KB.
// Keep startup and per-deferred-chunk limits unchanged.
// 0.58 completes the modular pixel Agents creator, shared animation renderer,
// furnished headquarters and native work/review profiles. Measured total 515,236
// gzip bytes; bound this capability tranche at 520 KB. Character rendering and
// agent editing remain deferred; startup (180 KB) and chunk (80 KB) limits hold.
// 0.59.1 replaces the long hub with a balanced central campus and shared paths.
// Measured total 520,759 (+786 over 0.59.0, 0.15%). Cap total at 522 KB;
// startup and individual deferred-chunk ceilings remain unchanged.
// 0.60 completes the lazy Content writing, agent proposal, review, version and
// library workspace. First coherent measurement: 533,678 total gzip bytes
// (+12,919 over 0.59.1, 2.48%); startup 129,595. Bound this tranche at 537 KB.
// Startup and per-deferred-chunk ceilings remain unchanged.
// 0.61 adds the deferred Profile/quest editor and full-ledger progression.
// Measured 541,904 total gzip bytes (+7,858, 1.47% over delivered 0.60).
// Bound total at 544 KB; startup and per-chunk ceilings remain unchanged.
// 0.62 adds deferred encrypted backup and recovery review controls.
// Measured total 545,394 (+3,476 over delivered 0.61); preserve startup/chunk ceilings.
// 0.64 adds deferred import review and local predecessor-backup decryption.
// Measured total 549,182 (+2,398 over 0.63.7, 0.44%). Keep startup/chunk limits.
// 0.68 adds deferred Profile disclosure for verified imported XP. Measured total
// 551,284 (+380 over 0.67, 0.07%). Keep startup and per-chunk limits; cap at552 KB.
// 0.70 adds parent-task selection and navigation with retained draft protection.
// Measured total 552,047 (+732 bytes, 0.13%); startup and chunk limits stay fixed.
// 0.73 adds reviewed recovery reconnection and labelled saved transcripts.
// Measured 554,294 total (+1,307 / 0.24%); startup and chunk ceilings stay fixed.
// 0.74 adds the deferred saved-transcript continuation dialog. Bound this
// tranche at 558 KB; startup and individual deferred chunk ceilings stay fixed.
// 0.75 adds accessible retained Settings categories and defers account setup.
// Measured total 559,178 (+2,002 / 0.36%); startup falls after lazy Settings.
// Bound the tranche at 560 KB; startup and per-chunk ceilings stay fixed.
// 1.1 conditional reads and bounded idle polling add 579 gzip bytes (0.10%)
// to eliminate repeated full state transfers. Measured total 560,373 bytes.
// Bound this addition at 561 KB; startup and deferred-chunk ceilings stay fixed.
// 1.1.2 adds authenticated upload pieces after the real Vercel body-limit failure.
// Measured total 561,046 (+696 gzip bytes / 0.12%); keep startup/chunk ceilings.
// 1.2 adds deferred installation, verified downloads and desktop-link controls.
// Measured 565,093 gzip bytes (+4,047); retain startup and individual chunk limits.
// 1.4 adds provider allowance and seven-day activity in a lazy Settings panel.
// Measured total 567,671 gzip bytes; cap at 569 KB. Startup/chunk limits hold.
// 1.5 adds lazy GitHub preparation/publication, team workflows and host-browser
// panels. First coherent total: 577,770 (+10,099 / 1.78%). Bound the tranche
// at 580 KB; preserve the 180 KB startup and 80 KB deferred-chunk ceilings.
export const clientLimits = { startup: 180000, total: 580000, deferredChunk: 80000 };

export function measureClient(manifest, bytesByFile, limits = clientLimits) {
  const entries = Object.keys(manifest).filter(key => manifest[key].isEntry);
  assert.ok(entries.length, 'Build manifest has no entry');
  const seen = new Set(), startupFiles = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    assert.ok(chunk, `Missing static import in build manifest: ${key}`);
    if (chunk.file.endsWith('.js')) {
      assert.ok(bytesByFile.has(chunk.file), `Missing entry/import bytes: ${chunk.file}`);
      startupFiles.add(chunk.file);
    }
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  entries.forEach(visit);
  const startup = [...startupFiles].reduce((sum, file) => sum + bytesByFile.get(file), 0);
  const total = [...bytesByFile.values()].reduce((sum, size) => sum + size, 0);
  const deferred = [...bytesByFile].filter(([file]) => !startupFiles.has(file));
  assert.ok(startup < limits.startup, `Startup JS exceeds ${limits.startup} gzip bytes: ${startup}`);
  assert.ok(total < limits.total, `Total JS exceeds ${limits.total} gzip bytes: ${total}`);
  for (const [file, bytes] of deferred) assert.ok(bytes < limits.deferredChunk, `Deferred JS exceeds ${limits.deferredChunk} gzip bytes: ${file} (${bytes})`);
  return { startupGzipBytes: startup, totalGzipBytes: total, startupFiles: [...startupFiles].sort(), deferredChunks: Object.fromEntries(deferred), limits };
}
