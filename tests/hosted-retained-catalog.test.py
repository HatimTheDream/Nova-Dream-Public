"""Focused catalog admission tests; no native runtime, database or original IO.

These exercise the production normalization seam after official derivation.
The actual native derivation and settled startup remain separately required.
"""
import copy
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/update-runner/hosted_retained_catalog.py'
SPEC = importlib.util.spec_from_file_location('catalog_under_test', SOURCE)
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


def record(name, generation):
    return {'pluginId': name, 'origin': 'config', 'enabled': True,
            'rootDir': '/candidate/' + generation + '/' + name,
            'manifestHash': generation * 64, 'packageVersion': generation,
            'manifestFile': {'size': 100, 'mtimeMs': 1000, 'ctimeMs': 1000},
            'packageJson': {'path': 'package.json', 'hash': generation * 64,
                            'fileSignature': {'size': 50, 'mtimeMs': 1000, 'ctimeMs': 1000}},
            'startup': {'commands': ['before' if generation == 'a' else 'after']},
            'contributions': {'channels': [], 'providers': [], 'contracts': {}}, 'compat': []}


def fixture():
    old = {'version': 1, 'warning': 'official', 'hostContractVersion': '2026.9.8',
           'compatRegistryVersion': 'c' * 64, 'migrationVersion': 1,
           'policyHash': '1' * 64, 'generatedAtMs': 1000,
           'installRecords': {'codex': {'source': 'npm', 'integrity': 'unchanged'}},
           'diagnostics': [], 'plugins': [record(name, 'a') for name in catalog.APP_PLUGINS if name != catalog.DIRECT]}
    old['plugins'].extend([{'pluginId': 'memory-core', 'origin': 'bundled', 'enabled': True,
                           'contributions': {'channels': [], 'providers': [], 'contracts': {}}, 'compat': []},
                          {'pluginId': 'codex', 'enabled': True, 'packageBuild': {'bundledDist': True}}])
    new = copy.deepcopy(old)
    new.update(policyHash='2' * 64, generatedAtMs=2000)
    new['plugins'] = [record(name, 'b') for name in catalog.APP_PLUGINS] + copy.deepcopy(old['plugins'][-2:])
    new['plugins'][-2]['enabled'] = False
    derived = {'format': 1, 'nativeVersion': '2026.9.8', 'sides': []}
    for index in (old, new):
        official = copy.deepcopy(index)
        official['plugins'] = [row for row in official['plugins'] if row['pluginId'] in catalog.APP_PLUGINS]
        derived['sides'].append({'index': official, 'policyHash': index['policyHash'],
                                 'memoryEnabled': next(row['enabled'] for row in index['plugins']
                                                       if row['pluginId'] == 'memory-core')})
    return [old, new], derived


class CatalogAdmission(unittest.TestCase):
    def test_exact_official_transition_normalizes_and_does_not_mutate_inputs(self):
        pair, derived = fixture(); original = copy.deepcopy((pair, derived))
        old, new = catalog._normalize(pair, derived)
        self.assertEqual(old['plugins'], new['plugins'])
        self.assertEqual(old['policyHash'], new['policyHash'])
        self.assertEqual((pair, derived), original)

    def test_candidate_record_extra_capability_refused(self):
        pair, derived = fixture(); pair[1]['plugins'][0]['contributions']['unreviewed'] = ['write']
        with self.assertRaisesRegex(RuntimeError, 'semantics'):
            catalog._normalize(pair, derived)

    def test_forged_native_policy_refused(self):
        pair, derived = fixture(); derived['sides'][1]['policyHash'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'policy hash'):
            catalog._normalize(pair, derived)

    def test_direct_addition_must_be_officially_derived(self):
        pair, derived = fixture(); derived['sides'][1]['index']['plugins'].pop()
        with self.assertRaisesRegex(RuntimeError, 'membership'):
            catalog._normalize(pair, derived)

    def test_direct_insertion_position_must_match_official_config_discovery(self):
        pair, derived = fixture()
        direct = pair[1]['plugins'].pop(4)
        pair[1]['plugins'].insert(0, direct)
        with self.assertRaisesRegex(RuntimeError, 'membership'):
            catalog._normalize(pair, derived)

    def test_unrelated_membership_and_order_refused(self):
        for mode in ('add', 'remove', 'reorder'):
            with self.subTest(mode=mode):
                pair, derived = fixture()
                if mode == 'add': pair[1]['plugins'].append({'pluginId': 'unknown'})
                elif mode == 'remove': pair[1]['plugins'].pop()
                else: pair[1]['plugins'][-2:] = pair[1]['plugins'][-2:][::-1]
                with self.assertRaisesRegex(RuntimeError, 'membership|order'):
                    catalog._normalize(pair, derived)

    def test_changed_installation_or_diagnostic_refused(self):
        for field in ('installRecords', 'diagnostics'):
            with self.subTest(field=field):
                pair, derived = fixture(); pair[1][field] = {'other': {}} if field == 'installRecords' else [{'level': 'warn'}]
                with self.assertRaisesRegex(RuntimeError, 'installations|diagnostics'):
                    catalog._normalize(pair, derived)

    def test_memory_enablement_is_native_derived(self):
        pair, derived = fixture(); derived['sides'][1]['memoryEnabled'] = True
        with self.assertRaisesRegex(RuntimeError, 'enablement'):
            catalog._normalize(pair, derived)

    def test_memory_unrelated_metadata_is_not_normalized(self):
        pair, derived = fixture(); pair[1]['plugins'][-2]['compat'].append('new-authority')
        with self.assertRaisesRegex(RuntimeError, 'beyond derived'):
            catalog._normalize(pair, derived)

    def test_non_application_delta_survives_for_existing_full_checker(self):
        pair, derived = fixture(); pair[1]['plugins'][-1]['packageBuild']['extra'] = True
        old, new = catalog._normalize(pair, derived)
        self.assertNotEqual(old['plugins'][-1], new['plugins'][-1])

    def test_file_metadata_only_ignores_prequalified_copy_ctime(self):
        pair, derived = fixture()
        derived['sides'][0]['index']['plugins'][0]['manifestFile']['ctimeMs'] = 4000
        catalog._normalize(pair, derived)
        derived['sides'][0]['index']['plugins'][0]['manifestFile']['mtimeMs'] = 4000
        with self.assertRaisesRegex(RuntimeError, 'semantics'):
            catalog._normalize(pair, derived)


if __name__ == '__main__':
    unittest.main()
