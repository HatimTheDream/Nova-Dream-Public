import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawUpdateFeed, newerAgentVersion } from '../apps/service/openclaw-update-feed.js';

function fixture() {
  let now = Date.parse('2026-09-24T12:00:00Z'), saved: unknown, calls = 0, installed = '2026.9.2';
  let response = () => new Response(JSON.stringify({ tag_name: 'v2026.9.6', draft: false, prerelease: false, html_url: 'https://github.com/openclaw/openclaw/releases/tag/v2026.9.6' }));
  const options = { installed: () => installed, now: () => now, read: () => saved, write: (value: unknown) => { saved = structuredClone(value); }, fetch: (async (url, init) => {
    calls++; assert.equal(url, 'https://api.github.com/repos/openclaw/openclaw/releases/latest'); assert.equal(init?.redirect,'error'); assert.equal(init?.credentials,'omit'); return response();
  }) as typeof fetch };
  const feed = new OpenClawUpdateFeed(options);
  return { feed, options, calls:()=>calls, advance:(ms:number)=>{now+=ms;}, respond:(value:typeof response)=>{response=value;}, installed:(value:string)=>{installed=value;} };
}
test('official discovery survives reload, coalesces callers and reports real installed/latest versions', async () => {
  const f = fixture(); await Promise.all([f.feed.check(),f.feed.check(true)]); assert.equal(f.calls(),1);
  assert.equal(f.feed.status().state,'available'); assert.equal(f.feed.status().version,'2026.9.6');
  assert.equal(new OpenClawUpdateFeed(f.options).status().state,'available');
  await f.feed.check(true); assert.equal(f.calls(),1);
  f.installed('2026.9.6'); assert.equal(f.feed.status().state,'current');
  f.installed('2026.9.7'); assert.equal(f.feed.status().state,'current');
  f.advance(37*3_600_000); assert.equal(f.feed.status().state,'unavailable');
});
test('failed or invalid release discovery cannot claim up to date or expose stale availability', async () => {
  for (const respond of [()=>{throw Error('offline');},()=>new Response('x'.repeat(128*1024+1)),()=>new Response(JSON.stringify({tag_name:'v2026.9.6',draft:false,prerelease:true,html_url:'https://github.com/openclaw/openclaw/releases/tag/v2026.9.6'})),()=>new Response(JSON.stringify({tag_name:'v2026.9.6',draft:false,prerelease:false,html_url:'https://untrusted.test/'}))]) {
    const f=fixture();await f.feed.check();f.advance(5*60_000);f.respond(respond);await f.feed.check(true);
    assert.equal(f.feed.status().state,'unavailable');assert.equal(f.feed.status().version,undefined);
    assert.equal(new OpenClawUpdateFeed(f.options).status().state,'unavailable');
  }
});
test('stable version ordering uses numeric components and rejects unsupported labels',()=>{
  assert(newerAgentVersion('2026.10.1','2026.9.6'));assert(!newerAgentVersion('2026.9.2','2026.9.6'));
  assert(!newerAgentVersion('2026.9.6-beta.1','2026.9.2'));assert(!newerAgentVersion('latest','2026.9.2'));
});
