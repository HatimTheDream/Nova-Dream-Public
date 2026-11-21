"""Local file safety checks for the bounded returned-rehearsal reader."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]/'scripts/full-host-primitives/collect-returned-completion.py'
spec = importlib.util.spec_from_file_location('returned_completion_reader', SOURCE)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class ReturnedFiles(unittest.TestCase):
    def test_file_limits_reject_oversized_files_and_hardlinks_before_open(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(reader, 'protected', create=True):
            path = Path(tmp)/'capture.json'
            path.write_bytes(b'{}')
            with self.assertRaisesRegex(ValueError, 'oversized'):
                reader.returned_file(path, 1)
            os.link(path, Path(tmp)/'alias.json')
            with self.assertRaisesRegex(ValueError, 'linked'):
                reader.returned_file(path, 128 * 1024)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux O_NOFOLLOW/O_NOATIME reader')
    def test_raw_size_and_hash_belong_to_the_same_open_original_file(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp, patch.object(reader, 'protected', create=True):
            path = Path(tmp)/'capture.json'
            raw = b'{"format":1}\n'
            path.write_bytes(raw)
            self.assertEqual(reader.returned_file(path, len(raw)),
                             ({'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}, {'format':1}))
            alias = path.with_suffix('.link')
            alias.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'linked'):
                reader.returned_file(alias, len(raw))
            path.write_bytes(b'{"a":1,"a":2}')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                reader.returned_file(path, 64)

    def test_changed_expected_digest_is_refused_before_receipt_content_can_be_used(self):
        # Feed the first actual reader comparison an altered digest. This requires
        # no root access and never enters the protected namespace.
        values = {'leaseId':'synthetic'}
        output = Path('/var/lib/nova-operator-rehearsals/rehearsal-synthetic')
        rows = {name:{'bytes':8, 'sha256':'1'*64} for name in reader.returned_role_limits()}
        from types import SimpleNamespace
        from contextlib import nullcontext
        with patch.object(reader, 'protected', create=True), patch.object(Path, 'stat'), \
             patch.object(reader.os, 'scandir', return_value=nullcontext([SimpleNamespace(name=n) for n in rows])), \
             patch.object(reader, 'returned_file', return_value=({'bytes':8,'sha256':'2'*64}, {})):
            with self.assertRaisesRegex(ValueError, 'Original returned startup receipt changed'):
                reader.returned_roster(output, values, {}, rows)


if __name__ == '__main__':
    unittest.main()
