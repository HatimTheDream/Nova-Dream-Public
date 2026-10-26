// Pure maintained-builder composition. The Python caller authenticates the
// complete source closure and derives sessionBindings from the BEFORE Store.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function deriveConfiguration(input) {
assert.deepEqual(Object.keys(input).sort(), ['before','bridge','epoch','nativeRoot','proxy','releaseRoot','runtimeEntry','sessionBindings'].sort());
const service = join(input.releaseRoot, 'dist/service/apps/service');
const load = name => import(pathToFileURL(join(service, name + '.js')).href);
const { withWorkerPlugin } = await load('worker-runtime-config');
const { withSourcePlugin } = await load('source-runtime-config');
const { withAccountPlugin } = await load('account-runtime-config');
const { withModulePlugin } = await load('module-runtime-config');
const { withDirectAgentPlugin } = await load('direct-agent-runtime-config');
const raw = structuredClone(input.before);
// Existing-state-only route: retain the complete managed browser policy and
// its retained CDP port. Only its observed owned proxy endpoint is regenerated.
assert.equal(raw.browser.enabled, true);
assert.equal(raw.browser.defaultProfile, 'nova-work');
assert.equal(raw.browser.evaluateEnabled, false);
assert.deepEqual(raw.browser.ssrfPolicy, { dangerouslyAllowPrivateNetwork:true });
assert.equal(raw.browser.extraArgs.length, 4);
assert.match(raw.browser.extraArgs[0], /^--proxy-server=http:\/\/127\.0\.0\.1:[0-9]{1,5}$/);
assert.deepEqual(raw.browser.extraArgs.slice(1), ['--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
assert.deepEqual(Object.keys(raw.browser).sort(), ['enabled','defaultProfile','evaluateEnabled','ssrfPolicy','extraArgs','profiles'].sort());
assert.deepEqual(Object.keys(raw.browser.profiles), ['nova-work']);
assert.deepEqual(Object.keys(raw.browser.profiles['nova-work']).sort(), ['cdpPort','headless']);
assert.equal(raw.browser.profiles['nova-work'].headless, false);
assert(Number.isSafeInteger(raw.browser.profiles['nova-work'].cdpPort) && raw.browser.profiles['nova-work'].cdpPort > 0 && raw.browser.profiles['nova-work'].cdpPort < 65536);
raw.browser.extraArgs[0] = '--proxy-server=' + input.proxy;
raw.tools = {...raw.tools,deny:[...new Set([...(raw.tools?.deny??[]),'browser'])]};
raw.gateway = {...raw.gateway,nodes:{...raw.gateway?.nodes,browser:{mode:'off'}}};
raw.plugins = {...raw.plugins,allow:[...new Set([...(raw.plugins?.allow??[]),'browser'])],entries:{...raw.plugins?.entries,browser:{...raw.plugins?.entries?.browser,enabled:true}}};
const worker = withWorkerPlugin(raw, input.epoch, join(service,'worker-plugin'), join(input.nativeRoot,'assignment-receipts'));
const source = withSourcePlugin(worker, input.epoch, join(service,'source-plugin'), join(input.nativeRoot,'source-cache'));
const account = withAccountPlugin(source, input.epoch, join(service,'account-plugin'), input.runtimeEntry);
const module = withModulePlugin(account, input.epoch, join(service,'module-plugin'), {...input.bridge,sessionBindings:input.sessionBindings});
const result = withDirectAgentPlugin(module,input.epoch,input.nativeRoot,join(service,'direct-agent-plugin'),input.bridge,{group:true});
const rawResult = JSON.stringify(result);
assert(Buffer.byteLength(rawResult) <= 4*1024*1024);
return result;
}

export async function assertConfiguration(input, actual) {
  const expected = await deriveConfiguration(input);
  assert.deepEqual(actual, expected, 'Complete generated configuration differs from maintained BEFORE derivation');
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { after, ...input } = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(await assertConfiguration(input, after)));
}
