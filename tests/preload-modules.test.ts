import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { createModuleRegistry } from '../apps/client/src/preload-lazy';
import { readPreparedView, keepPreparedView, calendarViewRange } from '../apps/client/src/prepared-views';

test('startup warms lazy children discovered by parent imports and first render does not suspend', async () => {
  const registry = createModuleRegistry(); let childLoads = 0, parentLoads = 0;
  let Child: ReturnType<typeof registry.lazy>;
  const Parent = registry.lazy(async () => {
    parentLoads++;
    Child = registry.lazy(async () => { childLoads++; return { default: () => createElement('span', null, 'Ready child') }; });
    return { default: () => createElement(Child) };
  });
  const seen: number[][] = [];
  await registry.prepare((done,total) => seen.push([done,total]));
  assert.deepEqual(seen.at(-1), [2,2]);
  const markup = renderToString(createElement(Suspense, { fallback:'Still loading' }, createElement(Parent)));
  assert.match(markup, /Ready child/); assert.doesNotMatch(markup, /Still loading/);
  await registry.prepare(); assert.equal(parentLoads,1); assert.equal(childLoads,1);
});

test('a failed module blocks readiness and can retry without reloading ready modules', async () => {
  const registry = createModuleRegistry(); let attempts = 0, readyLoads = 0;
  registry.lazy(async () => { readyLoads++; return {default:()=>null}; });
  registry.lazy(async () => { if (++attempts === 1) throw Error('Interrupted download'); return {default:()=>null}; });
  await assert.rejects(registry.prepare(), /Interrupted download/);
  await registry.prepare(); assert.equal(attempts,2); assert.equal(readyLoads,1);
});

test('prepared views cannot cross device or restored-workspace identities', () => {
  const original={epoch:'epoch-a',deviceId:'device-a'},other={epoch:'epoch-b',deviceId:'device-a'};
  keepPreparedView(original,'profile/progress',{level:3});
  assert.deepEqual(readPreparedView(original,'profile/progress'),{level:3});
  assert.equal(readPreparedView(other,'profile/progress'),undefined);
  assert.equal(readPreparedView({...original,deviceId:'device-b'},'profile/progress'),undefined);
  keepPreparedView(other,'profile/progress',{level:1});
  assert.equal(readPreparedView(original,'profile/progress'),undefined);
  assert.deepEqual(calendarViewRange('2026-09-16','UTC'), {from:'2026-08-30',to:'2026-10-11',timezone:'UTC'});
});
