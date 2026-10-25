import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

test('paired phones can reconcile app window actions through the two exact POST routes', () => {
  for (const path of ['/api/assistant/app-action-ready', '/api/assistant/app-action']) {
    assert.equal(phoneRouteAllowed(path, 'POST'), true, path);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(phoneRouteAllowed(path, method), false, `${method} ${path}`);
    for (const suffix of ['/', '/confirm', '-grant', 's', '?action=apply']) assert.equal(phoneRouteAllowed(path + suffix, 'POST'), false, path + suffix);
  }
});

test('app window acknowledgements do not open neighboring setup or model-tool authority routes', () => {
  for (const path of ['/workspace', '/workspace/policy', '/api/assistant/app-actions', '/api/assistant/app-action/apply',
    '/api/assistant/runtime/start', '/api/companions/challenge', '/api/companions/link', '/api/storage/backups/create', '/api/storage/imports/restore']) {
    assert.equal(phoneRouteAllowed(path, 'POST'), false, path);
  }
  for (const path of ['/api/assistant/module-action', '/api/assistant/module-actions']) assert.equal(phoneRouteAllowed(path, 'POST'), true, 'existing owner review route remains allowed');
});
test('paired phones can read only the exact Content receipt route and method',()=>{
 assert(phoneRouteAllowed('/api/content/workspace/receipt','POST'));
 for(const method of ['GET','PUT','PATCH','DELETE'])assert(!phoneRouteAllowed('/api/content/workspace/receipt',method));
 for(const suffix of ['/','/apply','s','?command=apply'])assert(!phoneRouteAllowed('/api/content/workspace/receipt'+suffix,'POST'));
});

test('Ideas history and original receipts expose only exact authenticated route methods',()=>{
 for(const method of ['GET','POST'])assert(phoneRouteAllowed('/api/home/ideas',method));
 assert(phoneRouteAllowed('/api/home/ideas/receipt','POST'));assert(!phoneRouteAllowed('/api/home/ideas/receipt','GET'));
 for(const path of ['/api/home/ideas/start','/api/home/ideas/send','/api/home/ideas/','/api/home/ideas/receipt/'])
  for(const method of ['GET','POST'])assert(!phoneRouteAllowed(path,method));
});
