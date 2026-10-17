import importlib.util
import pathlib
import unittest

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

if __name__ == '__main__':
    unittest.main()
