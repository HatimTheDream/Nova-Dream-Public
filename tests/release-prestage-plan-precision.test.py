"""Exact Python host integers remain authoritative across the real JS transport."""
import ast
import base64
import copy
import hashlib
import json
import os
import pathlib
import subprocess
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/full-host-primitives/asset-stage.py'


class PlanPrecisionTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(SOURCE.read_bytes())
        names = {'require', 'javascript_plan_projection_matches', 'verify_dispatch_plan'}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.scope = {'json': json, 'hashlib': hashlib}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), self.scope)
        self.exact = {
            'format': 1, 'readOnly': True, 'candidateId': 'a' * 64,
            'transferTimeout': {'identity': [2049, 12345, 33261, 0, 0, 115, 11352352,
                                            1776789153594696751, 1776789153594696753]},
            'capacity': {'freeBytes': 4000000000, 'requiredFreeBytes': 2000000000,
                         'futureReclaimCreditBytes': 0},
            'automaticReplayPermitted': False,
        }
        raw = (json.dumps(self.exact) + '\n').encode()
        # The actual boundary: Node parses Python stdout, then serializes the binding.
        result = subprocess.run([os.environ.get('NODE_BINARY', 'node'), '-e',
                                 'let s="";process.stdin.setEncoding("utf8");'
                                 'process.stdin.on("data",v=>s+=v);'
                                 'process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s))));'],
                                input=raw, capture_output=True, timeout=10, check=True)
        self.projected = json.loads(result.stdout)
        self.assertNotEqual(self.projected['transferTimeout']['identity'][8],
                            self.exact['transferTimeout']['identity'][8])
        self.current = copy.deepcopy(self.exact)
        self.observations = 0

        def plan():
            self.observations += 1
            return copy.deepcopy(self.current)

        self.scope.update(STAGE_PLAN=copy.deepcopy(self.projected),
                          STAGE_PLAN_RAW_BASE64=base64.b64encode(raw).decode(),
                          BUNDLE='b' * 64, NONCE='original-key', read_only_plan=plan,
                          STAGE_INTENT={'format': 1, 'kind': 'execute-exact-full-private-prestage',
                                        'planSha256': hashlib.sha256(raw).hexdigest(),
                                        'bundleSha256': 'b' * 64, 'nonce': 'original-key',
                                        'automaticReplayPermitted': False})

    def verify(self):
        self.scope['verify_dispatch_plan']()

    def test_real_js_roundtrip_retains_exact_raw_identity_and_original_hash(self):
        before = copy.deepcopy(self.scope['STAGE_INTENT'])
        self.verify()
        self.assertEqual(self.observations, 1)
        self.assertEqual(self.scope['STAGE_INTENT'], before)
        self.assertEqual(self.scope['STAGE_PLAN'], self.projected)

    def test_one_nanosecond_live_drift_is_refused_despite_same_js_number(self):
        self.current['transferTimeout']['identity'][8] += 1
        self.assertEqual(float(self.current['transferTimeout']['identity'][8]),
                         float(self.projected['transferTimeout']['identity'][8]))
        with self.assertRaisesRegex(RuntimeError, 'Exact readonly plan identity'):
            self.verify()

    def test_raw_hash_and_original_intent_cannot_be_replaced(self):
        for field, value in [('planSha256', '0' * 64), ('nonce', 'new-key'),
                             ('automaticReplayPermitted', True)]:
            with self.subTest(field=field):
                original = self.scope['STAGE_INTENT'][field]
                self.scope['STAGE_INTENT'][field] = value
                with self.assertRaisesRegex(RuntimeError, 'Separate exact execution intent'):
                    self.verify()
                self.scope['STAGE_INTENT'][field] = original
        self.scope['STAGE_PLAN_RAW_BASE64'] = base64.b64encode(b'{}').decode()
        with self.assertRaisesRegex(RuntimeError, 'Separate exact execution intent'):
            self.verify()
        self.assertEqual(self.observations, 0)

    def test_contradictory_projected_values_keys_types_and_integer_buckets_refused(self):
        for change in [lambda p: p.update(candidateId='c' * 64),
                       lambda p: p.update(readOnly=1),
                       lambda p: p.update(extra=True),
                       lambda p: p['transferTimeout']['identity'].append(0),
                       lambda p: p['transferTimeout']['identity'].__setitem__(0, 2050),
                       lambda p: p['transferTimeout']['identity'].__setitem__(8, p['transferTimeout']['identity'][8] + 512)]:
            self.scope['STAGE_PLAN'] = copy.deepcopy(self.projected)
            change(self.scope['STAGE_PLAN'])
            with self.assertRaisesRegex(RuntimeError, 'JavaScript projection'):
                self.verify()
        self.assertEqual(self.observations, 0)

    def test_capacity_contract_stays_exact_while_free_space_can_change(self):
        self.current['capacity']['freeBytes'] -= 4096
        self.verify()
        self.current['capacity']['requiredFreeBytes'] -= 1
        with self.assertRaisesRegex(RuntimeError, 'Capacity contract changed'):
            self.verify()

    def test_changed_raw_exact_integer_is_not_hidden_by_unchanged_projection(self):
        altered = copy.deepcopy(self.exact)
        altered['transferTimeout']['identity'][8] += 1
        raw = json.dumps(altered).encode()
        self.scope['STAGE_PLAN_RAW_BASE64'] = base64.b64encode(raw).decode()
        self.scope['STAGE_INTENT']['planSha256'] = hashlib.sha256(raw).hexdigest()
        with self.assertRaisesRegex(RuntimeError, 'Exact readonly plan identity'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
