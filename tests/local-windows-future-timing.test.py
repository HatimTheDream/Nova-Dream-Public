"""One new exact future timing boundary; no native/process/plan execution."""
import ast
import copy
from pathlib import Path
import types
import unittest

HERE=Path(__file__).resolve()
CAP=384*1024**2


def functions(path,names):
    tree=ast.parse(path.read_text(encoding='utf-8'))
    selected=ast.Module(body=[node for node in tree.body
        if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
    namespace={'capture':types.SimpleNamespace(MAX_REPORT_BYTES=CAP)}
    exec(compile(selected,str(path),'exec'),namespace)
    return namespace


class FutureTimingTests(unittest.TestCase):
    def test_exact_future_budgets_legacy_boundary_and_underbudget_refusals(self):
        entry=functions(HERE.parents[1]/'scripts/local-native-retained-qualification.py',
            {'need','qualification_return_reserve','capture_cleanup_configuration','qualification_representation'})
        spec={'maximumSeconds':900,'maximumCaptures':4,'finalizationSeconds':120,
            'effectiveWorkerTimeoutSeconds':11220}
        inner={'totalTimeoutMs':6300000,'captureRepresentation':'physical-graph-v3',
            'limits':{'maxReportBytes':CAP},'captureCleanup':spec}
        custody={'totalTimeoutSeconds':10200,'returnReserveSeconds':1800,
            'captureCleanup':{**spec,'maximumCaptures':6}}
        self.assertEqual(entry['qualification_return_reserve'](300000,6300000,CAP,capture_cleanup=spec),1800)
        self.assertEqual(entry['capture_cleanup_configuration'](inner),spec)
        self.assertEqual(entry['capture_cleanup_configuration'](custody,maximum_captures=6,work_seconds=10200),custody['captureCleanup'])
        self.assertEqual(6300-1800,4500)
        self.assertEqual(10200+900+120,spec['effectiveWorkerTimeoutSeconds'])
        # No expanded authority for a historical plan without explicit admission.
        self.assertEqual(entry['qualification_return_reserve'](300000,3600000,CAP),900)
        with self.assertRaises(RuntimeError):entry['qualification_return_reserve'](300000,6300000,CAP)
        for changed in ({**spec,'effectiveWorkerTimeoutSeconds':11219},{**spec,'maximumSeconds':901},
                        {**spec,'maximumCaptures':6},{**spec,'finalizationSeconds':119}):
            with self.subTest(spec=changed),self.assertRaises(RuntimeError):
                entry['qualification_return_reserve'](300000,6300000,CAP,capture_cleanup=changed)
        for total in (3600000,6299999,6300001):
            with self.subTest(inner_total=total),self.assertRaises(RuntimeError):
                entry['qualification_return_reserve'](300000,total,CAP,capture_cleanup=spec)
        invalid=copy.deepcopy(inner);invalid['captureRepresentation']='physical-graph-v2'
        with self.assertRaises(RuntimeError):entry['capture_cleanup_configuration'](invalid)


if __name__=='__main__':unittest.main()
