"""Pure fresh-admission timing checks; no native calls, files or runtime start."""
import importlib.util
from pathlib import Path
import unittest

ENTRY = Path(__file__).resolve().parents[1] / 'scripts/local-native-retained-qualification.py'
SPEC = importlib.util.spec_from_file_location('local_qualification_timing', ENTRY)
entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entry)


class QualificationTimingTests(unittest.TestCase):
    def test_legacy_and_intermediate_limits_keep_existing_timing(self):
        for report_bytes in (1, 256*1024**2, 256*1024**2+1, 384*1024**2-1):
            for ready, total in ((1000, 61000), (1000, 300000), (300000, 1800000)):
                with self.subTest(report_bytes=report_bytes, total=total):
                    self.assertEqual(entry.qualification_return_reserve(ready, total, report_bytes),
                                     min(300, total/3000))
            with self.assertRaisesRegex(RuntimeError, 'Finite original'):
                entry.qualification_return_reserve(300000, 1800001, report_bytes)

    def test_exact_enlarged_route_has_fixed_reserve_and_finite_new_ceiling(self):
        report_bytes = 384*1024**2
        self.assertEqual(entry.capture.MAX_REPORT_BYTES, report_bytes)
        with self.assertRaisesRegex(RuntimeError, 'Finite original'):
            entry.qualification_return_reserve(300000, 3600000, float(report_bytes))
        for total in (1800000, 2700000, 3600000):
            self.assertEqual(entry.qualification_return_reserve(300000, total, report_bytes), 900)
        for ready, total in ((300000, 1799999), (300000, 3600001), (999, 3600000),
                             (300001, 3600000), (300000, True), ('300000', 3600000)):
            with self.subTest(ready=ready, total=total):
                with self.assertRaisesRegex(RuntimeError, 'Finite original'):
                    entry.qualification_return_reserve(ready, total, report_bytes)
        # Reserve selection subtracts from an already fixed deadline; it never
        # returns a new wall-clock deadline or grants another operation budget.
        original_deadline = 8000
        self.assertEqual(original_deadline - entry.qualification_return_reserve(300000, 3600000, report_bytes), 7100)


if __name__ == '__main__':
    unittest.main()
