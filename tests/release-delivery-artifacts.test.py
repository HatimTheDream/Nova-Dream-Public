"""No Git, credentials, network, runtime launch or host effects."""
import importlib.util
import io
import json
import pathlib
import types
import unittest
import uuid
import zipfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
definition = importlib.util.spec_from_file_location('delivery_artifacts', ROOT / 'scripts/release-delivery-artifacts.py')
D = importlib.util.module_from_spec(definition); definition.loader.exec_module(D)


class ArtifactProducerTests(unittest.TestCase):
    def fixture(self):
        key = str(uuid.uuid4()); root = ROOT / 'support/fixtures' / ('delivery-artifacts-' + key)
        executable = ROOT / 'scripts/release-delivery-artifacts.py'
        tool = {'path': str(executable), 'sha256': D.C.sha(executable.read_bytes())}
        request = {'format': 1, 'operationId': str(uuid.uuid4()), 'key': key, 'inputSha256': 'a' * 64, 'version': '2.3.1', 'buildVersion': '1.0.288',
                   'sources': {}, 'ci': {}, 'outputDirectory': str(root), 'helperHashes': {n: D.C.sha((ROOT / 'scripts' / n).read_bytes()) for n in ('release-delivery-artifacts.py', 'release-artifact-primitives.py')},
                   'tools': {'git': tool, 'node': tool, 'python': tool, 'ciNodeSha256': 'f' * 64, 'nodeToolchain': {'nodeVersion': '22.23.2', 'platform': 'win32', 'arch': 'x64'}}}
        bound = {'scripts/update-app-archive.py': {'sha256': 'b' * 64}, 'scripts/candidate.mjs': {'sha256': 'c' * 64}}
        zips = {}
        for side, repo, commit in [('private', 'Nova-Dream', 'd' * 40), ('public', 'Nova-Dream-Public', 'e' * 40)]:
            request['sources'][side] = {'repository': 'HatimTheDream/' + repo, 'commit': commit, 'root': str(ROOT)}
            request['ci'][side] = {'sourceCommit': commit, 'runId': 123 if side == 'private' else 124, 'runAttempt': 1}
            archive = b'synthetic archive; actual verification is explicitly mocked in this orchestration test'
            metadata = {'format': 1, 'version': '2.3.1', 'buildVersion': '1.0.288', 'schemaVersion': 1, 'apiVersion': 1, 'candidateId': 'a' * 64,
                        'archiveBytes': len(archive), 'archiveSha256': D.C.sha(archive), 'expandedBytes': 1, 'fileCount': 1, 'packageLockSha256': 'b' * 64}
            receipt = {'format': 1, 'kind': 'canonical-ci-built-candidate', 'sourceCommit': commit, 'repository': 'HatimTheDream/' + repo,
                       'runId': str(request['ci'][side]['runId']), 'runAttempt': '1', 'toolchain': {'nodeVersion': '22.23.2', 'platform': 'linux', 'arch': 'x64'},
                       'nodeSha256': 'f' * 64, 'packagerSha256': 'b' * 64, 'candidateVerifierSha256': 'c' * 64, 'application': metadata, 'rebuilt': False, 'deliveryQualification': False}
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as archive_file:
                for name, raw in {'app.tgz': archive, 'app.tgz.metadata.json': json.dumps(metadata).encode(), 'ci-source.json': json.dumps(receipt).encode()}.items():
                    archive_file.writestr(name, raw)
            zips[repo] = stream.getvalue()
        def frozen(repo, commit, git, **kwargs):
            path = root / ('frozen-source-' + repo + '-' + commit)
            if not path.exists(): path.mkdir()
            return path, bound
        def exact(repo, selected, token):
            self.assertEqual(token, 'synthetic-token-never-external')
            raw = zips[repo]
            return '/repos/HatimTheDream/' + repo, {'workflow_id': 1}, {'id': 2}, [], {'id': selected['runId'], 'size_in_bytes': len(raw), 'digest': 'sha256:' + D.C.sha(raw)}
        def verify(source, bounds, output, metadata, node, **kwargs):
            path = output / 'verified-application'
            if not kwargs['verify_existing']: path.mkdir()
            return {'id': metadata['candidateId']}
        return request, zips, frozen, exact, verify

    def test_original_complete_collection_observes_without_redownload_or_credentials(self):
        request, zips, frozen, exact, verify = self.fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), patch.object(D.C, 'exact_run', side_effect=exact) as api, \
             patch.object(D.C, 'download_zip', side_effect=lambda prefix, *_: zips[prefix.split('/')[-1]]) as download, patch.object(D.C, 'verify_application', side_effect=verify):
            first = D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            second = D.collect(request, observe=True, token_provider=lambda _: self.fail('Observe must not request credentials'))
            self.assertEqual(first, second); self.assertEqual(api.call_count, 2); self.assertEqual(download.call_count, 2)
            archive = pathlib.Path(second['output']['repositories']['private']['archive']['path']); archive.write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'retained-archive-corrupt'):
                D.collect(request, observe=True, token_provider=lambda _: self.fail('No credentials'))
            self.assertEqual(download.call_count, 2)

    def test_partial_original_output_is_preserved_and_never_replayed(self):
        request, *_ = self.fixture(); output = pathlib.Path(request['outputDirectory']); output.mkdir()
        (output / 'partial.txt').write_text('preserve original worker output')
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'download_zip') as download:
            with self.assertRaises((RuntimeError, FileNotFoundError)):
                D.collect(request, observe=True, token_provider=lambda _: self.fail('No credential request'))
            self.assertTrue((output / 'partial.txt').exists()); download.assert_not_called()

    def test_changed_helper_fails_before_tool_or_network_invocation(self):
        request, *_ = self.fixture(); request['helperHashes']['release-artifact-primitives.py'] = '0' * 64
        with patch.object(D.subprocess, 'run') as process, patch.object(D.C, 'download_zip') as download:
            with self.assertRaisesRegex(RuntimeError, 'artifact-helper-changed'): D.collect(request)
            process.assert_not_called(); download.assert_not_called()

    def test_maintained_zip_parser_rejects_added_path_before_extraction(self):
        request, *_ = self.fixture(); root = pathlib.Path(request['outputDirectory']); root.mkdir()
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as archive:
            archive.writestr('../escape', b'bad')
        with self.assertRaisesRegex(RuntimeError, 'exactly the three'):
            D.C.extract_zip(raw.getvalue(), root)
        self.assertEqual(list(root.iterdir()), [])

    def test_positive_integrity_refusal_is_distinct_from_an_unavailable_response(self):
        failure = D.failure_result(RuntimeError('retained-archive-corrupt'))
        self.assertEqual(failure['state'], 'failed'); self.assertEqual(failure['reason'], 'retained-archive-corrupt')
        for error in (RuntimeError('credential-provider-unavailable'), TimeoutError('private sensitive timeout details'), FileNotFoundError('private path')):
            value = D.failure_result(error)
            self.assertEqual(value['state'], 'uncertain'); self.assertEqual(value['reason'], 'original-artifact-collection-unverified')


if __name__ == '__main__': unittest.main()
