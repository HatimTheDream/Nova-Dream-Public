"""Focused report-memory admission cases. No native capture or Windows API call."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'scripts/local-native-retained-qualification.py'
spec = importlib.util.spec_from_file_location('local_report_capacity_entry', path)
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)
capture = entry.capture


def observation(available):
    return {'source': 'GetPerformanceInfo', 'observedEpochMs': 1, 'pageSizeBytes': 4096,
            'commitLimitBytes': available + 1024**3, 'committedBytes': 1024**3,
            'availableCommitBytes': available, 'physicalAvailableBytes': 0}


class ReportCapacity(unittest.TestCase):
    def test_original_report_limits_keep_their_existing_admission_behavior(self):
        with patch.object(capture, 'observe_windows_commit_capacity') as read:
            for maximum in (1, 16 * 1024**2, 256 * 1024**2):
                self.assertEqual(capture.admit_report_commit_capacity(maximum),
                                 {'admissionRequired': False, 'maxReportBytes': maximum,
                                  'reason': 'within-original-report-ceiling'})
        read.assert_not_called()

    def test_exact_commit_boundary_is_independent_of_physical_residency(self):
        maximum = capture.MAX_REPORT_BYTES
        self.assertEqual(maximum, 384 * 1024**2)
        required = capture.required_report_commit_bytes(maximum)
        self.assertEqual(required, 17448304640)
        with patch.object(capture, 'observe_windows_commit_capacity', return_value=observation(required)) as read:
            result = capture.admit_report_commit_capacity(maximum)
        read.assert_called_once_with()
        self.assertEqual(result['requiredCommitBytes'], required)
        self.assertTrue(result['admissionRequired'])
        self.assertEqual(result['availableCommitBytes'], required)
        self.assertEqual(result['physicalAvailableBytes'], 0)
        with patch.object(capture, 'observe_windows_commit_capacity', return_value=observation(required - 1)):
            with self.assertRaisesRegex(capture.CaptureRefused, 'report-commit-capacity-unavailable') as refused:
                capture.admit_report_commit_capacity(maximum)
        self.assertEqual(refused.exception.observations['requiredCommitBytes'], required)

    def test_unknown_or_inconsistent_observation_and_unbounded_report_refuse(self):
        required = capture.required_report_commit_bytes(capture.MAX_REPORT_BYTES)
        for bad in (0, True, -1, capture.MAX_REPORT_BYTES + 1, float(capture.MAX_REPORT_BYTES)):
            with self.subTest(bad=bad), patch.object(capture, 'observe_windows_commit_capacity') as read:
                with self.assertRaisesRegex(capture.CaptureRefused, 'report-memory-budget-range'):
                    capture.admit_report_commit_capacity(bad)
                read.assert_not_called()
        good = observation(required)
        for key, bad in [('source', 'estimated'), ('availableCommitBytes', required + 1),
                         ('committedBytes', -1), ('observedEpochMs', 0), ('pageSizeBytes', True)]:
            value = copy.deepcopy(good); value[key] = bad
            with self.subTest(key=key), patch.object(capture, 'observe_windows_commit_capacity', return_value=value):
                with self.assertRaisesRegex(capture.CaptureRefused, 'windows-commit-observation-invalid'):
                    capture.admit_report_commit_capacity(capture.MAX_REPORT_BYTES)

    def test_entry_refuses_before_capture_custody_host_or_evidence_writes(self):
        plan = {'limits': {'maxReportBytes': capture.MAX_REPORT_BYTES}}
        refusal = capture.CaptureRefused('report-commit-capacity-unavailable')
        with (patch.object(entry.os, 'name', 'nt'), patch.object(entry, 'admit', return_value=(plan, 1000)),
              patch.object(capture, 'admit_report_commit_capacity', side_effect=refusal),
              patch.object(capture, 'capture_closed_tree') as tree,
              patch.object(entry, 'rename_role') as rename,
              patch.object(entry, 'run_host') as host,
              patch.object(entry, 'save') as save):
            with self.assertRaisesRegex(capture.CaptureRefused, 'report-commit-capacity-unavailable'):
                entry.execute('unused-plan', 'unused-intent')
        tree.assert_not_called(); rename.assert_not_called(); host.assert_not_called(); save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
