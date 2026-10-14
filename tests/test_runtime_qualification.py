"""Portable synthetic archives verify ingestion, never actual qualification."""
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile
import time
import unittest
import zipfile

sys.dont_write_bytecode = True
SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('runtime_sources', SCRIPTS / 'release-runtime-qualification.py')
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)


def encoded(value):
    return (json.dumps(value, sort_keys=True) + '\n').encode()


class Sources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-runtime-source-test-')
        self.addCleanup(self.temp.cleanup); self.root = pathlib.Path(self.temp.name).resolve(); self.calls = []
        self.runtime = {'format': 1, 'fromVersion': '2026.9.6', 'toVersion': '2026.9.8', 'archiveBytes': 7,
            'archiveSha256': M.sha(b'fixture'), 'expandedBytes': 20, 'fileCount': 1, 'nodeVersion': '24.21.0', 'nodeSha256': '3' * 64,
            'companion': {'pluginVersion': '2026.9.8', 'codexVersion': '0.158.0', 'packageLockSha256': '4' * 64, 'binarySha256': '5' * 64}}
        self.binding = {'format': 1, 'kind': 'reviewed-runtime-artifact-binding', 'runId': '11', 'runtimeSourceCommit': 'a' * 40,
            'qualificationSourceCommit': 'b' * 40, 'runtimeArchiveSha256': self.runtime['archiveSha256'], 'artifactId': 12,
            'artifactName': 'offline-runtime-2026.9.8-' + 'a' * 40, 'workflow': '.github/workflows/offline-runtime.yml',
            'conclusion': 'success', 'repository': 'HatimTheDream/Nova-Dream'}
        native = {'harnessSha256': '6' * 64, 'syntheticOnly': True, 'producerExecuted': True,
                  'preservationVerifierRequired': True, 'packageVersion': '2026.9.8'}
        codex = {'kind': 'official-codex-migration-producer', 'binarySha256': '5' * 64, 'version': 'codex-cli 0.158.0',
                 'producer': {'exitCode': 0}, 'savedWorkAccepted': False, 'independentVerifierRequired': True}
        self.qualification = {'format': 1, 'kind': 'official-runtime-producer-qualification', 'binding': self.binding,
            'runtime': self.runtime, 'networkInterfaces': ['lo'], 'syntheticOnly': True, 'savedWorkAccepted': False,
            'independentVerifierRequired': True, 'dependencyRebuild': False, 'serviceActions': False,
            'producerLogs': {'native': M.sha(b'fixture native log'), 'codex': M.sha(b'fixture codex log')},
            'sourceFiles': {'qualify-native-migration.mjs': '6' * 64, 'qualify-runtime-artifact.py': '7' * 64, 'qualify-codex-migration.py': '8' * 64},
            'producerReceipts': {'native': {'path': 'native/producer-manifest.json', 'sha256': M.sha(encoded(native))},
                                 'codex': {'path': 'codex/producer-receipt.json', 'sha256': M.sha(encoded(codex))}}}
        self.build_members = {'runtime.tgz': b'fixture', 'runtime.metadata.json': encoded(self.runtime),
            'build-receipt.json': encoded({'format': 1, 'runtime': self.runtime, 'status': 'prepared-not-installed',
                'serviceActions': False, 'signatureCreated': False, 'workspaceDataUsed': False})}
        self.qmembers = {'runtime-source-binding.json': encoded(self.binding),
            'runtime-producer-qualification/native-producer.log': b'fixture native log',
            'runtime-producer-qualification/codex-producer.log': b'fixture codex log',
            'runtime-producer-qualification/qualification-receipt.json': encoded(self.qualification),
            'runtime-producer-qualification/native/producer-manifest.json': encoded(native),
            'runtime-producer-qualification/codex/producer-receipt.json': encoded(codex)}
        self.request = {'format': 1, 'kind': 'retained-runtime-source-evidence', 'tools': {},
            'build': {'sourceCommit': 'a' * 40, 'runId': 11, 'runAttempt': 1, 'artifactId': 12, 'zip': self.zip('build.zip', self.build_members)},
            'synthetic': {'sourceCommit': 'b' * 40, 'runId': 21, 'runAttempt': 1, 'artifactId': 22, 'zip': self.zip('q.zip', self.qmembers)},
            'helperHashes': {name: M.sha((SCRIPTS / name).read_bytes()) for name in M.HELPERS}, 'independentVerifier': None}

    def zip(self, name, entries):
        path = self.root / name
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as output:
            for key, value in entries.items():
                output.writestr(key, value)
        return {'path': str(path), 'sha256': M.sha(path.read_bytes())}

    def api(self, path, token):
        self.calls.append(path); self.assertEqual(token, 'test-only')
        role = 'build' if '/11/' in path or path.endswith('/12') else 'synthetic'; item = self.request[role]
        if '/actions/runs/' in path:
            return 200, {'id': item['runId'], 'run_attempt': 1, 'head_sha': item['sourceCommit'],
                'path': '.github/workflows/' + ('offline-runtime.yml' if role == 'build' else 'runtime-qualification.yml'),
                'event': 'workflow_dispatch', 'status': 'completed', 'conclusion': 'success',
                'run_started_at': '2026-10-01T00:00:00Z', 'updated_at': '2026-10-01T00:05:00Z',
                'repository': {'full_name': 'HatimTheDream/Nova-Dream'}}
        return 200, {'id': item['artifactId'], 'name': ('offline-runtime-2026.9.8-' if role == 'build' else 'runtime-producer-evidence-') + item['sourceCommit'],
            'workflow_run': {'id': item['runId'], 'head_sha': item['sourceCommit']},
            'created_at': '2026-10-01T00:04:00Z',
            'size_in_bytes': pathlib.Path(item['zip']['path']).stat().st_size, 'digest': 'sha256:' + item['zip']['sha256']}

    def run_consumer(self, api=None):
        return M.consume(self.request, api or self.api, lambda _tools: 'test-only')

    def test_authenticated_source_ingestion_remains_explicit_gap_and_writes_nothing(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        value = self.run_consumer()
        self.assertTrue(value['sourceEvidenceVerified']); self.assertEqual(value['state'], 'gap')
        self.assertFalse(value['productionAdmission']); self.assertFalse(value['actualSettledQualification'])
        self.assertFalse(value['sdkExecuted']); self.assertFalse(value['workspaceDataOpened'])
        self.assertEqual(len(self.calls), 4); self.assertEqual(value['runtime']['nodeVersion'], '24.21.0')
        self.assertEqual(value['applicationNodeVersion'], '22.23.2')
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})

    def test_api_identity_and_missing_digest_do_not_fall_back_to_local_hash(self):
        for change in ('digest', 'source', 'attempt', 'workflow', 'old-artifact'):
            with self.subTest(change=change):
                def api(path, token):
                    status, data = self.api(path, token)
                    if '/artifacts/' in path and change == 'digest': data.pop('digest')
                    if '/artifacts/' in path and change == 'old-artifact': data['created_at'] = '2026-09-30T00:04:00Z'
                    if '/runs/' in path:
                        if change == 'source': data['head_sha'] = 'c' * 40
                        if change == 'attempt': data['run_attempt'] = 2
                        if change == 'workflow': data['path'] = '.github/workflows/quality.yml'
                    return status, data
                with self.assertRaises(RuntimeError): self.run_consumer(api)

    def test_synthetic_flags_and_runtime_binding_cannot_be_reinterpreted(self):
        for change in ('savedWorkAccepted', 'syntheticOnly', 'runtimeArchiveSha256'):
            with self.subTest(change=change):
                value = copy.deepcopy(self.qualification)
                if change == 'runtimeArchiveSha256': value['binding'][change] = '0' * 64
                else: value[change] = not value[change]
                members = dict(self.qmembers); members['runtime-producer-qualification/qualification-receipt.json'] = encoded(value)
                self.request['synthetic']['zip'] = self.zip('q.zip', members)
                with self.assertRaises(RuntimeError): self.run_consumer()

    def test_corrupt_archive_and_unsupported_profiles_refuse(self):
        for change in ('archive', 'node', 'from', 'file-count'):
            with self.subTest(change=change):
                entries = dict(self.build_members); meta = copy.deepcopy(self.runtime)
                if change == 'archive': entries['runtime.tgz'] = b'changed'
                if change == 'node': meta['nodeVersion'] = '22.23.2'
                if change == 'from': meta['fromVersion'] = '2026.9.2'
                if change == 'file-count': meta['fileCount'] = 100000
                entries['runtime.metadata.json'] = encoded(meta)
                self.request['build']['zip'] = self.zip('build.zip', entries)
                with self.assertRaises(RuntimeError): self.run_consumer()

    def test_unsafe_zip_paths_and_extra_build_members_refuse(self):
        for name in ('../escape', 'C:/escape', 'unexpected'):
            entries = dict(self.build_members); entries[name] = b'bad'
            self.request['build']['zip'] = self.zip('build.zip', entries)
            with self.assertRaises(RuntimeError): self.run_consumer()

    def test_missing_log_with_null_receipt_cannot_pass(self):
        value = copy.deepcopy(self.qualification); value['producerLogs']['native'] = None
        members = dict(self.qmembers); members.pop('runtime-producer-qualification/native-producer.log')
        members['runtime-producer-qualification/qualification-receipt.json'] = encoded(value)
        self.request['synthetic']['zip'] = self.zip('q.zip', members)
        with self.assertRaisesRegex(RuntimeError, 'producer-log-binding'): self.run_consumer()

    def test_current_independent_receipt_is_bound_but_never_actual_startup(self):
        helpers = {}
        for name in ('recovery.py', 'codex_log_retention.py'):
            p = self.root / name; p.write_bytes(b'fixture helper')
            helpers[name] = {'path': str(p), 'sha256': M.sha(p.read_bytes())}
        value = {'format': 1, 'kind': 'maintained-verifier-synthetic-migration-acceptance',
            'qualificationReceiptSha256': M.sha(self.qmembers['runtime-producer-qualification/qualification-receipt.json']),
            'helperSourceCommit': 'b' * 40, 'runtimeSourceCommit': 'a' * 40, 'runtimeArchiveSha256': self.runtime['archiveSha256'],
            'maintainedVerifierSha256': {k: v['sha256'] for k, v in helpers.items()},
            'syntheticSchemaAndSavedContentVerified': True, 'productionAcceptance': False,
            'notCovered': ['host lifecycle', 'relocated derived process caches', 'full workspace restoration']}
        p = self.root / 'verifier.json'; p.write_bytes(encoded(value)); reference = {'path': str(p), 'sha256': M.sha(p.read_bytes())}
        self.request['independentVerifier'] = {'receipt': reference, 'helpers': helpers}
        result = self.run_consumer(); self.assertEqual(result['gaps'], [M.GAP]); self.assertFalse(result['productionAdmission'])
        self.assertFalse(result['independentVerifierCurrencyEstablished'])
        value['maintainedVerifierSha256']['recovery.py'] = '0' * 64; p.write_bytes(encoded(value)); reference['sha256'] = M.sha(p.read_bytes())
        with self.assertRaisesRegex(RuntimeError, 'independent-verifier-binding'): self.run_consumer()

    def test_replaced_file_and_finite_deadline_refuse(self):
        p = self.root / 'plain'; p.write_bytes(b'a'); ref = {'path': str(p), 'sha256': M.sha(b'a')}
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            M.read_ref(ref, 10, time.monotonic() - 1)
        with self.assertRaisesRegex(RuntimeError, 'changed-during-read'):
            with M.opened(ref, 10, time.monotonic() + 5):
                p.write_bytes(b'changed')


if __name__ == '__main__': unittest.main()
