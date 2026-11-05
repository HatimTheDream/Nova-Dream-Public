import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { deriveConfiguration, assertConfiguration } from '../deploy/update-runner/local-retained-configuration.mjs';

// Compile the actual builders into this test's isolated output. The quality
// build lane owns dist and may not have produced it yet on a clean checkout.
const applicationRoot=fileURLToPath(new URL('../',import.meta.url));
const scratch=join(applicationRoot,'.tmp-qa');mkdirSync(scratch,{recursive:true});
const releaseRoot=mkdtempSync(join(scratch,'retained-configuration-'));
after(()=>{assert.equal(dirname(resolve(releaseRoot)),resolve(scratch));rmSync(releaseRoot,{recursive:true,force:true});});
const config=ts.readConfigFile(join(applicationRoot,'tsconfig.service.json'),ts.sys.readFile);
assert.equal(config.error,undefined);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,applicationRoot);
assert.deepEqual(parsed.errors,[]);
const builders=['worker','source','account','module','direct-agent'].map(name=>join(applicationRoot,'apps/service',name+'-runtime-config.ts'));
const program=ts.createProgram(builders,{...parsed.options,outDir:join(releaseRoot,'dist/service'),noEmit:false,incremental:false});
const emitted=program.emit();assert.equal(emitted.emitSkipped,false);assert.deepEqual(emitted.diagnostics,[]);
// Actual compiled builders; synthetic values only. No Store/native/host start.
test('complete maintained local configuration rejects an unrelated AFTER policy change', async () => {
  const before = {
    gateway:{bind:'loopback',controlUi:{enabled:false}},
    agents:{defaults:{heartbeat:{every:'0m'}}},
    plugins:{enabled:true,allow:['openai','codex'],entries:{openai:{enabled:true},codex:{enabled:true}}},
    cron:{enabled:false},update:{checkOnStart:false,auto:{enabled:false}},models:{catalogRefresh:{enabled:false}},
    browser:{enabled:true,defaultProfile:'nova-work',evaluateEnabled:false,
      ssrfPolicy:{dangerouslyAllowPrivateNetwork:true},
      extraArgs:['--proxy-server=http://127.0.0.1:49121','--proxy-bypass-list=<-loopback>',
        '--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      profiles:{'nova-work':{cdpPort:49122,headless:false}}},
  };
  const input={before,releaseRoot,epoch:'11111111-1111-4111-8111-111111111111',
    nativeRoot:join(releaseRoot,'.tmp-qa','never-created-retained-config'),
    runtimeEntry:join(releaseRoot,'.tmp-qa','never-imported-openclaw.mjs'),
    proxy:'http://127.0.0.1:49123',bridge:{url:'http://127.0.0.1:49124/workspace',token:'a'.repeat(64)},
    sessionBindings:[]};
  const saved=structuredClone(before), expected=await deriveConfiguration(input);
  await assertConfiguration(input,expected);
  assert.deepEqual(before,saved,'Derivation cannot modify its BEFORE authority');
  const altered=structuredClone(expected); altered.cron.enabled=true;
  await assert.rejects(assertConfiguration(input,altered),/Complete generated configuration differs/);
  assert.equal(expected.plugins.slots.memory,'none');
  assert.equal(expected.plugins.entries['memory-core'].enabled,false);
});

test('hosted schema transition derives headless policy without broadening local admission', async () => {
  const before={gateway:{bind:'loopback',controlUi:{enabled:false}},agents:{defaults:{heartbeat:{every:'0m'}}},
    plugins:{enabled:true,allow:['openai','codex'],entries:{openai:{enabled:true},codex:{enabled:true}}},
    cron:{enabled:false},update:{checkOnStart:false,auto:{enabled:false}},models:{catalogRefresh:{enabled:false}},
    browser:{enabled:true,defaultProfile:'nova-work',evaluateEnabled:false,ssrfPolicy:{dangerouslyAllowPrivateNetwork:true},
      extraArgs:['--proxy-server=http://127.0.0.1:49121','--proxy-bypass-list=<-loopback>',
        '--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      profiles:{'nova-work':{cdpPort:49122,headless:true}}}};
  const input={before,releaseRoot,epoch:'11111111-1111-4111-8111-111111111111',
    nativeRoot:join(releaseRoot,'.tmp-qa','never-created-hosted-config'),
    runtimeEntry:join(releaseRoot,'.tmp-qa','never-imported-openclaw.mjs'),
    proxy:'http://127.0.0.1:49123',bridge:{url:'http://127.0.0.1:49124/workspace',token:'a'.repeat(64)},sessionBindings:[]};
  const retained=structuredClone(before), options={browserHeadless:true};
  await assert.rejects(deriveConfiguration(input));
  const expected=await deriveConfiguration(input,options);
  await assertConfiguration(input,expected,options);
  assert.deepEqual(before,retained);
  assert.equal(expected.browser.profiles['nova-work'].headless,true);
  assert.equal(expected.agents.defaults.skipBootstrap,true);
  assert.equal(expected.plugins.entries['edition3-direct-agent'].config.token,input.bridge.token);
  assert.equal(expected.plugins.entries['edition3-direct-agent'].config.url,input.bridge.url+'/direct');
  const altered=structuredClone(expected);altered.browser.evaluateEnabled=true;
  await assert.rejects(assertConfiguration(input,altered,options),/Complete generated configuration differs/);
  await assert.rejects(deriveConfiguration(input,{browserHeadless:'true'}));
});
