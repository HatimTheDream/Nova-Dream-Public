"""No-network tests around the actual copied collect-ci API/log primitives."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('delivery_ci', HERE / 'scripts/release-delivery-ci.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class CiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-m2-ci-')
        self.addCleanup(self.temp.cleanup)
        self.key = str(uuid4())
        root = Path(self.temp.name) / ('ci-' + self.key)
        root.mkdir()
        self.request = {'format': 1, 'key': self.key, 'version': '2.3.1', 'source': {'repository': 'HatimTheDream/Nova-Dream',
            'commit': 'a' * 40, 'branch': 'main'}, 'tools': {}, 'externalId': None, 'outputDirectory': str(root),
            'helperHashes': {name: M.sha((HERE / 'scripts' / name).read_bytes()) for name in ('release-delivery-ci.py', 'release-ci-primitives.py')}}
        self.run = {'id': 123, 'run_attempt': 1, 'head_sha': 'a' * 40, 'name': 'Nova Dream quality and release history',
            'event': 'push', 'head_branch': 'main', 'repository': {'full_name': 'HatimTheDream/Nova-Dream'}, 'status': 'completed', 'conclusion': 'success'}
        self.jobs = {'total_count': 2, 'jobs': [{'id': 999, 'name': 'quality', 'status': 'completed', 'conclusion': 'success',
            'steps': [{'name': name, 'status': 'completed', 'conclusion': 'success'} for name in ('Run npm run quality', 'Verify Linux update recovery')]}, {'id': 1000, 'name': 'release', 'status':'completed', 'conclusion':'success'}]}
        self.release = {'id':456,'tag_name':'nova-v2.3.1','target_commitish':'a'*40,'draft':False,'prerelease':False}
        self.gitref = {'object':{'type':'commit','sha':'a'*40}}
        self.calls = []

    def api(self, path, token):
        self.assertEqual(token, 'mock-token')
        self.calls.append(path)
        if '/releases/tags/' in path:
            return 200, self.release
        if '/git/ref/tags/' in path:
            return 200, self.gitref
        if '/jobs?' in path:
            return 200, self.jobs
        if '/attempts/' in path:
            return 200, self.run
        return 200, {'total_count': 1, 'workflow_runs': [self.run]}

    def test_original_selection_is_retained_before_jobs_and_lost_response_does_not_reselect(self):
        with patch.object(M.C, 'api', side_effect=self.api), patch.object(M.C, 'log_bytes', side_effect=AssertionError('no logs before selection')):
            first = M.collect(self.request, lambda _: 'mock-token')
        self.assertEqual(first['externalId'], '123:1')
        self.assertEqual(len(self.calls), 1)
        # Model a response lost before the outer journal learned the ID.
        with patch.object(M.C, 'api', side_effect=AssertionError('no replacement discovery')):
            original = M.collect(self.request, lambda _: self.fail('no credentials needed'))
        self.assertEqual(original, first)

    def test_exact_attempt_jobs_and_retained_logs_use_maintained_readonly_primitives(self):
        with patch.object(M.C, 'api', side_effect=self.api), patch.object(M.C, 'log_bytes', return_value=b'quality passed\n') as logs:
            M.collect(self.request, lambda _: 'mock-token')
            self.request['externalId'] = '123:1'
            result = M.collect(self.request, lambda _: 'mock-token')
            self.assertEqual(result['state'], 'completed')
            again = M.collect(self.request, lambda _: 'mock-token')
            self.assertEqual(again, result)
            self.assertEqual(logs.call_count, 1)
        self.assertTrue(any('/runs/123/attempts/1/jobs?' in path for path in self.calls))
        self.assertFalse(any('/runs/123/jobs?' in path for path in self.calls))
        self.assertEqual(result['output']['release']['id'],456)
        self.assertEqual(json.loads(M.read_ref(result['receipt']))['repositories'][0]['runs'][0]['jobs'][1]['id'],1000)
        self.assertEqual(M.read_ref(result['receipt']), Path(result['receipt']['path']).read_bytes())

    def test_successful_workflow_cannot_mask_wrong_existing_release_or_tag_or_failed_release_job(self):
        with patch.object(M.C, 'api', side_effect=self.api), patch.object(M.C, 'log_bytes', return_value=b'quality passed\n'):
            M.collect(self.request, lambda _: 'mock-token')
            self.request['externalId'] = '123:1'
            for key,value in [('target_commitish','b'*40),('tag_name','nova-v2.3.2'),('draft',True),('prerelease',True),('id',0)]:
                original=self.release[key];self.release[key]=value
                with self.assertRaisesRegex(RuntimeError,'ci-source-release-changed'):
                    M.collect(self.request, lambda _: 'mock-token')
                self.release[key]=original
            self.gitref['object']['sha']='b'*40
            with self.assertRaisesRegex(RuntimeError,'ci-source-tag-changed'):
                M.collect(self.request, lambda _: 'mock-token')
            self.gitref['object']['sha']='a'*40;self.gitref['object']['type']='tag'
            with self.assertRaisesRegex(RuntimeError,'ci-source-tag-changed'):
                M.collect(self.request, lambda _: 'mock-token')
            self.jobs['jobs'][1]['conclusion']='failure'
            with self.assertRaisesRegex(RuntimeError,'ci-release-job-incomplete'):
                M.collect(self.request, lambda _: 'mock-token')

    def test_replacement_attempt_and_changed_helper_are_positive_failures(self):
        with patch.object(M.C, 'api', side_effect=self.api):
            M.collect(self.request, lambda _: 'mock-token')
            self.request['externalId'] = '123:1'
            self.run['run_attempt'] = 2
            with self.assertRaisesRegex(RuntimeError, 'ci-run-attempt-changed'):
                M.collect(self.request, lambda _: 'mock-token')
        self.request['helperHashes']['release-ci-primitives.py'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'ci-helper-changed'):
            M.collect(self.request, lambda _: self.fail('must reject before credential'))

    def test_credential_process_uses_exact_configured_git_and_exec_path(self):
        root = Path(self.temp.name)
        git = root / 'git-fixture'; git.write_bytes(b'not executed')
        python = root / 'python-fixture'; python.write_bytes(b'not executed')
        ref = lambda path: {'path': str(path), 'sha256': M.sha(path.read_bytes())}
        tools = {'git': ref(git), 'python': ref(python), 'gitExecPath': str(root)}
        class Completed:
            returncode = 0
            stdout = b'password=mock-secret\n'
        with patch.object(M.subprocess, 'run', return_value=Completed()) as run:
            self.assertEqual(M.credential(tools), 'mock-secret')
        args, kw = run.call_args
        self.assertEqual(args[0], [str(git), 'credential', 'fill'])
        self.assertEqual(kw['env']['GIT_EXEC_PATH'], str(root))
        self.assertEqual(kw['env']['GIT_TERMINAL_PROMPT'], '0')

    def test_real_cli_refuses_changed_request_before_any_credential_or_network_call(self):
        path = Path(self.temp.name) / 'request.json'
        path.write_text(json.dumps(self.request))
        result = subprocess.run([sys.executable, str(HERE / 'scripts/release-delivery-ci.py'), '--request', str(path),
                                 '--request-sha256', '0' * 64], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        output = json.loads(result.stdout)
        self.assertEqual(output['state'], 'failed')
        self.assertEqual(output['reason'], 'ci-request-changed')
        self.assertEqual(output['externalId'], None)


if __name__ == '__main__':
    unittest.main()
