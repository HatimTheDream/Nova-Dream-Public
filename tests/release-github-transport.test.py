"""Portable transport checks; no credential lookup or network requests."""
import importlib.util
import io
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import urllib.error

source=Path(__file__).resolve().parents[1]/'scripts/release-frontend-github-primitives.py'
spec=importlib.util.spec_from_file_location('release_github_transport',source)
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)

class TransportTests(TestCase):
    def test_no_ambient_credential_or_account_operations(self):
        self.assertFalse(hasattr(M,'credential'))
        self.assertFalse(hasattr(M,'GIT'))
        self.assertFalse(hasattr(M,'GIT_EXEC'))
        self.assertNotIn('Nova-Dream-Backups',source.read_text())

    def test_redirect_cannot_forward_authorization(self):
        with self.assertRaisesRegex(RuntimeError,'redirect rejected'):
            M.NoApiRedirect().redirect_request(None,None,302,'',{},'https://example.invalid')

    def test_exact_request_and_timeout(self):
        requests=[]
        class Response(io.BytesIO):
            status=200
        class Opener:
            def open(self,request,timeout):
                requests.append((request,timeout));return Response(b'{"ok":true}')
        with patch.object(M.urllib.request,'build_opener',return_value=Opener()):
            self.assertEqual(M.api('/repos/example/project','synthetic-token'),(200,{'ok':True}))
        request,timeout=requests[0]
        self.assertEqual(request.full_url,'https://api.github.com/repos/example/project')
        self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-token')
        self.assertEqual(request.get_header('User-agent'),'Nova-Reviewed-Release')
        self.assertEqual(timeout,45)

    def test_http_failure_does_not_echo_private_response(self):
        error=urllib.error.HTTPError('https://api.github.com/fixture',403,'private denial',{},io.BytesIO(b'private body'))
        with patch.object(M.urllib.request,'build_opener') as opener:
            opener.return_value.open.side_effect=error
            self.assertEqual(M.api('/fixture','synthetic-token'),(403,{'error':'GitHub API rejected request'}))
        with self.assertRaisesRegex(ValueError,'absolute'):
            M.api('https://example.invalid','synthetic-token')

if __name__=='__main__':main()
