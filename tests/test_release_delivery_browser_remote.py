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
        for mode in ('readiness', 'plan', 'start'):
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

class BrowserFixedReservationTest(unittest.TestCase):
    def fixture(self):
        session=str(uuid.uuid4());started=1700000000000
        binding={'sessionId':session,'options':{'timeoutMs':1800000}}
        reservation={'sessionId':session,'startedAtMs':started,'deadlineAtMs':started+1800000}
        grant={'issuedAtMs':started,'expiresAtMs':started+2400000,'browserReservation':reservation}
        original={'startedAtMs':started,'deadlineAtMs':started+1800000}
        return original,binding,grant

    def test_fixed_grant_clock_is_accepted_without_becoming_a_new_clock(self):
        original,binding,grant=self.fixture()
        browser.verify_browser_reservation(original,binding,grant)
        self.assertEqual(original['startedAtMs'],grant['browserReservation']['startedAtMs'])

    def test_changed_session_short_window_extended_clock_or_grant_is_rejected(self):
        import copy
        for change in ('session','duration','start','deadline','grant','boolean'):
            original,binding,grant=copy.deepcopy(self.fixture())
            if change=='session':binding['sessionId']=str(uuid.uuid4())
            if change=='duration':binding['options']['timeoutMs']=300000
            if change=='start':original['startedAtMs']+=1;original['deadlineAtMs']+=1
            if change=='deadline':grant['browserReservation']['deadlineAtMs']+=1
            if change=='grant':grant['expiresAtMs']=grant['browserReservation']['deadlineAtMs']-1
            if change=='boolean':grant['browserReservation']['startedAtMs']=True
            with self.assertRaisesRegex(RuntimeError,'browser-window-reservation-changed'):
                browser.verify_browser_reservation(original,binding,grant)

    def test_legacy_grant_does_not_acquire_recovery_behavior(self):
        browser.verify_browser_reservation({}, {}, {'issuedAtMs':1,'expiresAtMs':2})

if __name__ == '__main__':
    unittest.main()
