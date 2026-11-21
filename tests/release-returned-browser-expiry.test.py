"""Read-only classification of genuine systemd manager records for a timed-out browser."""
import copy
import importlib.util
from pathlib import Path
import unittest

source=Path(__file__).resolve().parents[1]/'scripts'/'release-delivery-browser-remote.py'
spec=importlib.util.spec_from_file_location('browser_expiry',source)
browser=importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class ManagerEvidence(unittest.TestCase):
    def setUp(self):
        self.active=dict(unit='nova-browser-example.service',invocationId='1'*32,bootId='2'*32,
                         deadlineAtMs=500000,runtimeMaxUsec=10000000,activeEnterMonotonicUsec=100)
        def record(msg,mono,real):
            return dict(_PID='1',UNIT=self.active['unit'],_BOOT_ID=self.active['bootId'],
                        INVOCATION_ID=self.active['invocationId'],MESSAGE=self.active['unit']+': '+msg,
                        __MONOTONIC_TIMESTAMP=str(mono),__REALTIME_TIMESTAMP=str(real))
        self.rows=[record('Started.',100,490000000),record('Service reached runtime time limit. Stopping.',10000100,500000000),
                   record("Failed with result 'timeout'.",10500100,500500000)]
        self.rows[0]['MESSAGE_ID']='39f53479d3a045ac8e11786248231fbf'
        self.active['managerJournal']=[{**self.rows[0],'category':'started'}]

    def test_both_authenticated_timeout_events_and_matching_lifetime(self):
        proof=browser.manager_timeout_entries(self.rows,self.active)
        self.assertEqual(set(proof),{'elapsed','failed'})
        rows=copy.deepcopy(self.rows)
        del rows[1]['INVOCATION_ID']
        self.assertEqual(browser.manager_timeout_entries(rows,self.active),proof)
        for change in [lambda r:r.pop(0),lambda r:r[0].update(__REALTIME_TIMESTAMP='1'),lambda r:r[0].update(INVOCATION_ID='0'*32)]:
            wrong=copy.deepcopy(rows);change(wrong)
            with self.assertRaises(RuntimeError): browser.manager_timeout_entries(wrong,self.active)

    def test_no_other_exit_replacement_or_untimed_pid_can_claim_expiry(self):
        for change in [lambda rows:rows.pop(),lambda rows:rows[1].update(_PID='1000'),
                       lambda rows:rows[1].update(_BOOT_ID='a'*32),lambda rows:rows[2].update(INVOCATION_ID='a'*32),
                       lambda rows:rows[1].update(MESSAGE='Manually stopped.'),lambda rows:rows[1].update(UNIT='other.service'),
                       lambda rows:rows[1].update(__MONOTONIC_TIMESTAMP='10'),lambda rows:rows[2].update(__REALTIME_TIMESTAMP='2'),
                       lambda rows:rows.append(rows[1]),lambda rows:rows.append(rows[0])]:
            wrong=copy.deepcopy(self.rows);change(wrong)
            with self.assertRaises(RuntimeError): browser.manager_timeout_entries(wrong,self.active)


if __name__=='__main__':unittest.main()
