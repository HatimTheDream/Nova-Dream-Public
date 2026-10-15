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
