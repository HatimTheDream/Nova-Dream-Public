"""Closed hosted-key reader: fixture only; Linux tests use the real app codec."""
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery
import workspace_key
spec = importlib.util.spec_from_file_location('derived_fixture', ROOT / 'tests/recovery-derived-state.test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                     'Hosted credential owner/mode semantics require isolated Linux root fixtures.')
class WorkspaceKeyReaderTests(unittest.TestCase):
    setUp = fixtures.DerivedStateTests.setUp
    tearDown = fixtures.DerivedStateTests.tearDown
    binding_fixture = fixtures.DerivedStateTests.binding_fixture

    def fixture(self):
        before, after, selected, key, node = self.binding_fixture()
        node = pathlib.Path(node).resolve()
        prior = self.root / 'prior'
        module = prior / 'dist/service/apps/service/server-key.js'
        module.parent.mkdir(parents=True)
        source = ROOT / 'dist/service/apps/service/server-key.js'
        self.assertTrue(source.is_file(), 'Build the service before the Linux key fixture.')
        shutil.copyfile(source, module)
        (prior / 'package.json').write_text('{"type":"module"}')
        (prior / 'dist/candidate.json').write_text(json.dumps({'artifacts': [
            {'path': 'dist/service/apps/service/server-key.js', 'sha256': recovery.digest(module)}]}))
        credential = self.root / 'server.key'
        credential.write_bytes(bytes(range(32,64))); credential.chmod(0o600)
        script = r'''
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const v=JSON.parse(readFileSync(0,'utf8'));
const {ServerKeyProtector}=await import(pathToFileURL(v.module));
const wrapped=await new ServerKeyProtector(v.credential,v.workspace).wrap(Buffer.from(v.key,'hex'));
writeFileSync(v.wrapper,JSON.stringify({format:1,application:'private.novadream.edition3.preview',provider:'server-secret',wrapped:wrapped.toString('base64')}));
'''
        subprocess.run([str(node), '--input-type=module', '-e', script], check=True, input=json.dumps({
            'module': str(module), 'credential': str(credential), 'workspace': str(before / selected),
            'wrapper': str(before / selected / 'workspace-key.json'), 'key': key.hex()}).encode(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return before, after, selected, key, node, prior, credential, module

    def test_real_selected_wrapper_unwrap_and_key_check_keep_all_inputs_unchanged(self):
        before, after, selected, expected, node, prior, credential, _ = self.fixture()
        identities = {p: recovery.digest(p) for p in self.root.rglob('*') if p.is_file()}
        key = workspace_key.read_workspace_key(before, credential, node, prior)
        try:
            self.assertIsInstance(key, bytearray)
            self.assertEqual(key, expected)
            recovery.verified_session_bindings(before, selected, after / selected / 'openclaw-runtime/openclaw.json', node, key)
        finally:
            key[:] = b'\0'*len(key)
        self.assertEqual(identities, {p: recovery.digest(p) for p in self.root.rglob('*') if p.is_file()})

    def test_wrong_credential_unreadable_wrapper_and_tampered_helper_never_fallback(self):
        before, _, selected, _, node, prior, credential, module = self.fixture()
        original = credential.read_bytes()
        credential.write_bytes(b'x'*32)
        with self.assertRaisesRegex(RuntimeError, 'could not be unlocked'):
            workspace_key.read_workspace_key(before, credential, node, prior)
        credential.write_bytes(original)
        wrapper = before / selected / 'workspace-key.json'
        wrapper_bytes = wrapper.read_bytes()
        wrapper.write_text('{"format":1,"provider":"windows-dpapi"}')
        with self.assertRaisesRegex(RuntimeError, 'existing hosted key wrapper'):
            workspace_key.read_workspace_key(before, credential, node, prior)
        wrapper.write_bytes(wrapper_bytes)
        module.write_text(module.read_text() + '\n// altered\n')
        with self.assertRaisesRegex(RuntimeError, 'verified prior candidate'):
            workspace_key.read_workspace_key(before, credential, node, prior)
        self.assertFalse((before / selected / 'preview.key').exists())

    def test_credential_inside_workspace_group_readable_or_hardlinked_is_rejected(self):
        before, _, _, _, node, prior, credential, _ = self.fixture()
        credential.chmod(0o640)
        with self.assertRaisesRegex(RuntimeError, 'private root-owned'):
            workspace_key.read_workspace_key(before, credential, node, prior)
        credential.chmod(0o600)
        os.link(credential, self.root / 'credential-link')
        with self.assertRaisesRegex(RuntimeError, 'private root-owned'):
            workspace_key.read_workspace_key(before, credential, node, prior)
        inside = before / 'secret'
        inside.write_bytes(b'x'*32); inside.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'outside'):
            workspace_key.read_workspace_key(before, inside, node, prior)

    def test_key_flow_has_no_secrets_in_arguments_environment_or_error_messages(self):
        before, _, _, key, node, prior, credential, _ = self.fixture()
        original_run = subprocess.run
        observed = []
        def capture(*args, **kwargs):
            observed.append((args, kwargs))
            return original_run(*args, **kwargs)
        with patch.object(workspace_key.subprocess, 'run', side_effect=capture):
            actual = workspace_key.read_workspace_key(before, credential, node, prior)
        self.assertEqual(actual, key)
        actual[:] = b'\0'*32
        self.assertEqual(len(observed), 1)
        args, kwargs = observed[0]
        self.assertNotIn(key.hex(), str(args))
        self.assertNotIn(str(credential), str(args))
        self.assertNotIn('NODE_OPTIONS', kwargs['env'])
        self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
        self.assertEqual(kwargs['stdout'], subprocess.PIPE)
        self.assertEqual(kwargs['timeout'], 18)


if __name__ == '__main__':
    unittest.main()
