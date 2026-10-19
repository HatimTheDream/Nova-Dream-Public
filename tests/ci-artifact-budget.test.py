"""Behavior checks for the actual pre-upload artifact storage admission."""
import importlib.util
import pathlib
import re
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('artifact_budget', ROOT / 'scripts/ci-artifact-budget.py')
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class StorageAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def file(self, name, size):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('wb') as stream:
            stream.truncate(size)
        return path

    def test_exact_limit_and_overlapping_paths_count_once(self):
        item = self.file('build/app.tgz', 100)
        result = budget.inspect([str(item.parent), str(item)], 100, 1)
        self.assertEqual((result['bytes'], result['files']), (100, 1))
        self.assertFalse(result['uploaded'])

    def test_large_runtime_bundle_refuses_before_upload(self):
        item = self.file('runtime.tgz', budget.MAXIMUM_BYTES + 1)
        with self.assertRaisesRegex(RuntimeError, 'byte-budget-exceeded'):
            budget.inspect([str(item)])

    def test_combined_small_files_cannot_evade_limit(self):
        self.file('a.json', 6)
        self.file('b.json', 6)
        with self.assertRaisesRegex(RuntimeError, 'byte-budget-exceeded'):
            budget.inspect([str(self.root / '*.json')], 10)

    def test_file_count_and_invalid_limit_refuse(self):
        self.file('a', 1)
        self.file('nested/b', 1)
        with self.assertRaisesRegex(RuntimeError, 'file-budget-exceeded'):
            budget.inspect([str(self.root)], 100, 1)
        with self.assertRaisesRegex(RuntimeError, 'byte-budget-invalid'):
            budget.inspect([str(self.root)], budget.MAXIMUM_BYTES + 1)

    def test_missing_and_empty_require_explicit_diagnostic_policy(self):
        with self.assertRaisesRegex(RuntimeError, 'input-missing'):
            budget.inspect([str(self.root / '*.missing')])
        with self.assertRaisesRegex(RuntimeError, 'input-empty'):
            budget.inspect([str(self.root)])
        self.assertEqual(budget.inspect([str(self.root / '*.missing')], allow_empty=True)['files'], 0)

    def test_recursive_directory_includes_nested_files(self):
        self.file('nested/deep/result.json', 17)
        self.assertEqual(budget.inspect([str(self.root) + '/**'])['bytes'], 17)
        with self.assertRaisesRegex(RuntimeError, 'recursive-pattern-refused'):
            budget.inspect([str(self.root / '**' / '*.json')])

    def test_symlink_file_and_directory_refused(self):
        target = self.file('data/item', 10)
        link = self.root / 'link'
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest('This account cannot create symbolic links; Linux canonical CI covers this case.')
        with self.assertRaisesRegex(RuntimeError, 'symlink-refused'):
            budget.inspect([str(link)])
        link.unlink()
        link.symlink_to(target.parent, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'symlink-refused'):
            budget.inspect([str(self.root)])


class WorkflowPolicyTests(unittest.TestCase):
    def test_every_actions_upload_has_a_finite_checked_budget_and_one_day_retention(self):
        repository = ROOT.parent if ROOT.name == 'edition3' else ROOT
        uploads = 0
        for workflow in (repository / '.github/workflows').glob('*.yml'):
            lines = workflow.read_text(encoding='utf-8').splitlines()
            for position, line in enumerate(lines):
                if 'uses: actions/upload-artifact@' not in line:
                    continue
                uploads += 1
                start = next(i for i in range(position, -1, -1) if lines[i].startswith('      - '))
                previous = next(i for i in range(start - 1, -1, -1) if lines[i].startswith('      - '))
                end = position + 1
                while end < len(lines) and (not lines[end].strip() or len(lines[end]) - len(lines[end].lstrip()) > 6):
                    end += 1
                admission, upload = '\n'.join(lines[previous:start]), '\n'.join(lines[start:end])
                with self.subTest(workflow=workflow.name, upload=uploads):
                    self.assertIn('ci-artifact-budget.py', admission)
                    self.assertIn('--maximum-bytes 16777216', admission)
                    count = re.search(r'--maximum-files (\d+)', admission)
                    self.assertIsNotNone(count)
                    self.assertLessEqual(int(count.group(1)), budget.MAXIMUM_FILES)
                    self.assertRegex(upload, r'(?m)^          retention-days: 1$')
                    if 'always()' in upload:
                        self.assertRegex(upload, r"steps\.[a-z0-9_]+\.outcome == 'success'")
        self.assertGreater(uploads, 0)


if __name__ == '__main__':
    unittest.main()
