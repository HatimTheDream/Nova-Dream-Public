import importlib.util
import pathlib
import unittest
import uuid

spec = importlib.util.spec_from_file_location('browser_remote', pathlib.Path(__file__).parents[1] / 'scripts' / 'release-delivery-browser-remote.py')
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)

class BrowserMemoryAdmissionTest(unittest.TestCase):
    def test_fixed_browser_cap_preserves_two_gib_host_reserve(self):
        self.assertEqual(browser.MEMORY_MAX_BYTES, 1024**3)
        self.assertEqual(browser.HOST_RESERVE_BYTES, 2*1024**3)
        for mode in ('plan', 'start'):
            with self.assertRaisesRegex(RuntimeError, 'browser-remote-memory-headroom-insufficient'):
                browser.memory_admission(mode, False, lambda: 3*1024**3-1)
            proof = browser.memory_admission(mode, False, lambda: 3*1024**3)
            self.assertEqual(proof['availableBytes'], proof['requiredBytes'])

    def test_observing_original_operation_does_not_require_launch_headroom(self):
        def forbidden():
            self.fail('retained observation sampled launch capacity')
        for mode in ('start', 'status', 'request', 'close', 'screenshot', 'cleanup'):
            self.assertIsNone(browser.memory_admission(mode, True, forbidden))

class BrowserLinkedSessionScopeTest(unittest.TestCase):
    def test_legacy_operation_scope_is_unchanged(self):
        operation=str(uuid.uuid4());root=pathlib.Path('/opt/nova-browser-data')
        session,directory,unit=browser.browser_session_scope(root,{'operationId':operation})
        self.assertEqual((session,directory,unit),(operation,root/operation,'nova-browser-'+operation))

    def test_successor_has_distinct_directory_and_unit_but_preserves_operation(self):
        operation=str(uuid.uuid4());successor=str(uuid.uuid4());root=pathlib.Path('/opt/nova-browser-data')
        binding={'operationId':operation,'sessionId':successor};before=dict(binding)
        session,directory,unit=browser.browser_session_scope(root,binding)
        self.assertEqual((session,directory,unit),(successor,root/successor,'nova-browser-'+successor))
        self.assertNotEqual(directory,root/operation);self.assertNotEqual(unit,'nova-browser-'+operation)
        self.assertEqual(binding,before)

    def test_reused_or_invalid_successor_identity_is_refused(self):
        operation=str(uuid.uuid4());root=pathlib.Path('/opt/nova-browser-data')
        for session in (operation,'../escape','not-a-uuid',str(uuid.uuid4()).upper()):
            with self.assertRaises((RuntimeError,ValueError)):
                browser.browser_session_scope(root,{'operationId':operation,'sessionId':session})

if __name__ == '__main__':
    unittest.main()
