import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot } from '../packages/domain/contracts.js';

const styles = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { Connections } = await import('../apps/client/src/Connections.js');
styles.deregister();

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
