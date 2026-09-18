import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Connections } from '../apps/client/src/Connections.js';
import type { Snapshot } from '../packages/domain/contracts.js';

test('initial Assistant setup is unknown and cannot start the host before status arrives', () => {
  // Server rendering observes the real component before any status read resolves.
  const html = renderToStaticMarkup(createElement(Connections, {
    snapshot: { epoch: 'connection-loading-fixture' } as Snapshot,
    online: true,
    openAssistant: () => assert.fail('Rendering must not start a conversation'),
  }));
  assert.match(html, /Checking Assistant connection/);
  assert.match(html, /Checking saved account/);
  assert.doesNotMatch(html, /Not connected|No account identity confirmed|Waiting for OpenClaw/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Checking this host/);
  assert.match(html, /<button aria-label="Refresh Assistant connection">/);
});
