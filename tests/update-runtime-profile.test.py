"""Exact runtime pairs and official companion boundary; synthetic data only."""
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('runtime_profile_driver', ROOT / 'deploy/update-runner/install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class RuntimeProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-runtime-profile-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()

    def test_exact_pairs_reach_host_validation_but_skips_downgrades_and_unknown_engines_refuse(self):
        class ReachedHost(Exception):
            pass
        job = '11111111-1111-4111-8111-111111111111'
        request_path = self.root / job / 'request.json'
        for old, new, allowed in [('2026.9.6', '2026.9.8', True), ('2026.9.8', '2026.9.8', True),
                                  ('2026.9.6', '2026.9.6', True), ('2026.9.2', '2026.9.6', True),
                                  ('2026.9.2', '2026.9.8', False), ('2026.9.8', '2026.9.6', False),
                                  ('2026.9.7', '2026.9.8', False)]:
            request = {'format': 1, 'jobId': job, 'hostConfiguration': str(self.root / 'host.json'),
                       'expectedPrior': {'candidateId': 'a' * 64, 'workspaceEpoch': job},
                       'release': {'candidateId': 'b' * 64, 'fromCandidateId': 'a' * 64, 'novaVersion': '2.2.0',
                                   'agentVersion': new, 'compatibility': {'fromAgentVersion': old,
                                   'fromSchemaVersion': 55, 'toSchemaVersion': 55, 'reviewed': True,
                                   'gatewayProtocol': 4, 'pluginVersion': '2.2.0'}}}
            def read(path, *_):
                if path == request_path:
                    return request
                raise ReachedHost()
            with self.subTest(old=old, new=new), patch.object(driver.sys, 'platform', 'linux'), \
                    patch.object(driver.os, 'geteuid', return_value=0, create=True), patch.object(driver, 'protected'), \
                    patch.object(driver, 'read_json', side_effect=read):
                with self.assertRaises(ReachedHost if allowed else RuntimeError):
                    driver.Driver(request_path).validate()

    def fixture_runtime(self):
        files = {'node/bin/node': b'node', 'node_modules/openclaw/package.json': b'{}',
                 'node_modules/openclaw/openclaw.mjs': b'export{}', 'package.json': b'{}', 'package-lock.json': b'{}',
                 'companions/codex/package-lock.json': b'{}',
                 'companions/codex/node_modules/@openclaw/codex/package.json': b'{}',
                 'companions/codex/node_modules/@openclaw/codex/openclaw.plugin.json': b'{}',
                 'companions/codex/node_modules/@openai/codex/package.json': b'{}',
                 'companions/codex/node_modules/@openai/codex-linux-x64/package.json': b'{}',
                 'companions/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex': b'fake executable'}
        archive = self.root / 'runtime.tgz'
        with tarfile.open(archive, 'w:gz') as output:
            for name, data in files.items():
                member = tarfile.TarInfo(name); member.size = len(data)
                output.addfile(member, io.BytesIO(data))
            link = tarfile.TarInfo('companions/codex/node_modules/openclaw')
            link.type, link.linkname = tarfile.SYMTYPE, '../../../node_modules/openclaw'
            output.addfile(link)
        runtime = {'format': 1, 'fromVersion': '2026.9.6', 'toVersion': '2026.9.8',
                   'archiveBytes': archive.stat().st_size, 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                   'expandedBytes': sum(map(len, files.values())), 'fileCount': len(files) + 1,
                   'nodeVersion': '24.21.0', 'nodeSha256': 'd' * 64,
                   'companion': {'pluginVersion': '2026.9.8', 'codexVersion': '0.158.0',
                                 'packageLockSha256': 'b' * 64, 'binarySha256': 'c' * 64}}
        instance = driver.Driver(self.root / 'request.json')
        instance.from_engine, instance.to_engine = '2026.9.6', '2026.9.8'
        instance.pair, instance.release = {'runtime': runtime}, {'runtimeBundle': {'bytes': runtime['archiveBytes'], 'sha256': runtime['archiveSha256']}}
        instance.bundle = instance.runtime_root = self.root
        instance.agent, instance.agent_node = types.SimpleNamespace(is_symlink=lambda: True), types.SimpleNamespace(is_symlink=lambda: True, node=True)
        return instance, runtime

    def test_98_archive_requires_exact_signed_closure_node_and_companion(self):
        instance, runtime = self.fixture_runtime()
        with patch.object(driver, 'protected'):
            instance.validate_runtime()
            original = copy.deepcopy(runtime)
            for container, key, changed in [(runtime, 'nodeVersion', '22.23.2'),
                    (runtime['companion'], 'pluginVersion', '2026.9.6'),
                    (runtime['companion'], 'codexVersion', '0.155.1'),
                    (runtime, 'archiveSha256', 'f' * 64)]:
                with self.subTest(key=key):
                    old = container[key]; container[key] = changed
                    with self.assertRaises(RuntimeError):
                        instance.validate_runtime()
                    container[key] = old
            self.assertEqual(runtime, original)
        self.assertFalse(instance.stop_attempted or instance.workspace_mutated)

    def test_same_engine_app_update_needs_no_runtime_and_upgrade_requires_it(self):
        instance = driver.Driver(self.root / 'request.json')
        instance.pair, instance.release = {}, {}
        instance.from_engine = instance.to_engine = '2026.9.8'
        instance.validate_runtime()
        instance.from_engine = '2026.9.6'
        with self.assertRaisesRegex(RuntimeError, 'offline runtime closure'):
            instance.validate_runtime()

    @unittest.skipUnless(shutil.which('node'), 'Node exercises the exact maintained JS boundary')
    def test_98_official_companion_installs_once_and_rejects_changed_binary_dependency_permission_or_records(self):
        profile = driver.RUNTIME_PROFILES['2026.9.8']
        engine = self.root / 'runtime/node_modules/openclaw'
        dist = engine / 'dist'; dist.mkdir(parents=True)
        companion = self.root / 'runtime/companions/codex'
        plugin = companion / 'node_modules/@openclaw/codex'; plugin.mkdir(parents=True)
        state = self.root / 'state'
        installed = state / 'npm/projects/reviewed-codex/node_modules/@openclaw/codex'; installed.mkdir(parents=True)
        binary_relative = 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
        expected_binary = companion / binary_relative
        installed_binary = installed.parents[2] / binary_relative
        for path in (expected_binary, installed_binary):
            path.parent.mkdir(parents=True); path.write_bytes(b'synthetic verified executable')
        integrity = 'sha512-' + 'A' * 86 + '=='
        (companion / 'package-lock.json').write_text(json.dumps({'packages': {
            'node_modules/@openclaw/codex': {'version': '2026.9.8', 'integrity': integrity}}}))
        fixture = {'source': 'npm', 'spec': '@openclaw/codex@2026.9.8', 'resolvedSpec': '@openclaw/codex@2026.9.8',
                   'resolvedName': '@openclaw/codex', 'resolvedVersion': '2026.9.8', 'version': '2026.9.8',
                   'integrity': integrity, 'installPath': str(installed)}
        (dist / 'fixture.mjs').write_text('''
import{readFileSync,writeFileSync}from'node:fs';import assert from'node:assert/strict';
const data=JSON.parse(process.env.TEST_RECORD),mode=process.env.TEST_MODE;
let records={codex:mode==='already'?data:{source:'npm',version:mode==='prior'?'2026.9.2':'2026.9.6'},other:{saved:true}};
export const read=async()=>structuredClone(records);
export const snapshot=async()=>({config:JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH)),hash:'fixture'});
export async function install(input){
 assert.notEqual(mode,'already');assert.equal(input.request.spec,'@openclaw/codex@2026.9.8');assert.equal(input.request.expectedIntegrity,data.integrity);
 await input.onCapabilityConsent({pluginId:'codex',reviewToken:mode==='surface'?'changed':process.argv[3]});
 records.codex={...data,...(mode==='integrity'?{integrity:'sha512-wrong'}:{})};if(mode==='unrelated')records.other={saved:false};
 writeFileSync(process.env.TEST_CALLED,'called');return{ok:true};
}
export const replace=async({nextConfig})=>writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(nextConfig));
export const refresh=async()=>{};export const health=async()=>[];export const close=async()=>{};
export const discover=()=>({candidates:[{rootDir:data.installPath,origin:'global'}]});
''')
        for role, function, alias in [('config','snapshot','c'),('install','install','installManagedPluginSource'),
                ('records','read','r'),('health','health','a'),('mutate','replace','r'),('refresh','refresh','n'),
                ('discovery','discover','n'),('stateDatabase','close','closeOpenClawStateDatabaseAsync')]:
            (dist / profile[role]).write_text(f"export {{{function} as {alias}}} from './fixture.mjs';")
        config = self.root / 'config.json'
        for mode in ('install', 'already', 'binary', 'dependency', 'surface', 'integrity', 'unrelated', 'prior'):
            with self.subTest(mode=mode):
                (installed / 'package.json').write_text(json.dumps({'name':'@openclaw/codex','version':'2026.9.8',
                    'dependencies':{'@openai/codex':'0.155.1' if mode=='dependency' else '0.158.0'}}))
                installed_binary.write_bytes(b'changed' if mode=='binary' else expected_binary.read_bytes())
                config.write_text(json.dumps({'plugins':{'load':{'paths':['/retained',str(plugin)]}}}))
                called = self.root / ('called-' + mode)
                env = {**os.environ,'OPENCLAW_CONFIG_PATH':str(config),'OPENCLAW_STATE_DIR':str(state),
                       'TEST_RECORD':json.dumps(fixture),'TEST_MODE':mode,'TEST_CALLED':str(called)}
                result = subprocess.run([shutil.which('node'),'--input-type=module','-e',driver.CODEX_INSTALL,
                    str(engine),str(plugin),driver.CODEX_SURFACE,'2026.9.8'],env=env,capture_output=True,text=True,timeout=15)
                if mode in ('install','already'):
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertEqual(json.loads(config.read_text())['plugins']['load']['paths'],['/retained'])
                    self.assertEqual(called.exists(),mode=='install')
                    self.assertEqual(json.loads(result.stdout)['codexVersion'],'0.158.0')
                else:
                    self.assertNotEqual(result.returncode,0)
                    self.assertNotIn('companionInstalled',result.stdout)


if __name__ == '__main__':
    unittest.main()
