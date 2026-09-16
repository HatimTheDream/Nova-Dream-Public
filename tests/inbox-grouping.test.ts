import test from 'node:test';
import assert from 'node:assert/strict';
import {sortGroupedInboxThreads, normalizeInboxGrouping, inboxGroupKey} from '../apps/client/src/dreamclaw/services/executive/inboxGrouping';
const threads=[
 {id:'newsletter-new',from:'News <news@example.test>',accountLabel:'personal',category:'promo_social',date:'2026-09-12T10:00:00Z'},
 {id:'person',from:'Alex <alex@example.test>',accountLabel:'work',category:'personal_outreach',date:'2026-09-12T09:00:00Z'},
 {id:'newsletter-old',from:'News <news@example.test>',accountLabel:'personal',category:'promo_social',date:'2026-09-12T08:00:00Z'},
 {id:'pinned',from:'News <news@example.test>',accountLabel:'personal',category:'promo_social',date:'2026-09-11T08:00:00Z',isPinned:true},
];
test('mail defaults to chronological order while chosen groups stay contiguous and keep within-group sort',()=>{
 assert.equal(normalizeInboxGrouping(null),'none');
 assert.deepEqual(sortGroupedInboxThreads(threads,'none').map(t=>t.id),['pinned','newsletter-new','person','newsletter-old']);
 assert.deepEqual(sortGroupedInboxThreads(threads,'topic').map(t=>t.id),['pinned','person','newsletter-new','newsletter-old']);
 assert.deepEqual(sortGroupedInboxThreads(threads,'topic','oldest').map(t=>t.id),['pinned','person','newsletter-old','newsletter-new']);
 for(const group of ['topic','sender','recipient'] as const){const keys=sortGroupedInboxThreads(threads,group).filter(t=>!t.isPinned).map(t=>inboxGroupKey(t,group)); const runs=keys.filter((k,i)=>i===0||k!==keys[i-1]);assert.equal(runs.length,new Set(keys).size);}
 assert.deepEqual(threads.map(t=>t.id),['newsletter-new','person','newsletter-old','pinned']);
});

import {normalizeGmailIndexThreads} from '../packages/domain/dreamclaw/mail-index';
test('Gmail search rows retain actual snippets without manufacturing a repeated sender preview',()=>{
 const [withPreview,withoutPreview]=normalizeGmailIndexThreads([{id:'one',subject:'Review',from:'Alex',snippet:'The plan is ready.'},{id:'two',subject:'Review',from:'Alex'}]);
 assert.equal(withPreview.latestSnippet,'The plan is ready.');assert.equal(withPreview.summary,'The plan is ready.');
 assert.equal(withoutPreview.latestSnippet,'');assert.equal(withoutPreview.summary,'Review');
});
