import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/'experiments'/f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TRACE = load('trace_analysis')
PLAN = load('prepare_client_study')


class TraceTests(unittest.TestCase):
    def test_real_dygk_fields_and_request_intervals(self):
        watermark = 'DYGK-DL-'+'a'*48
        events = [
            {'ts': 1000, 'kind': 'http_fingerprint', 'session': 's', 'data': {'userAgent': 'curl', 'headerOrder': '1234'}},
            {'ts': 1001, 'kind': 'page_render', 'session': 's', 'data': {'path': '/_dygk/verify'}},
            {'ts': 31000, 'kind': 'http_fingerprint', 'session': 's', 'data': {}},
            {'ts': 31001, 'kind': 'client_downloaded', 'session': 's', 'data': {'watermark': watermark}},
            {'ts': 32000, 'kind': 'challenge_completed', 'session': 's', 'data': {'watermark': watermark}},
        ]
        tools = [{'stage': 'terminal', 'content': watermark}, {'stage': 'report', 'content': 'DYGK-PAGE-'+'b'*24}]
        result = TRACE.analyze(events, tools)
        session = result['sessions']['s']
        self.assertEqual(session['request_gaps_seconds']['p50'], 30)
        self.assertEqual(len(result['pairs']), 1)
        self.assertEqual(len(result['pairs'][0]['events']), 2)
        self.assertEqual(len(result['unmatched_tool_watermarks']), 1)
        self.assertTrue(session['challenge_completed'])
        self.assertFalse(session['marker_execution_evidence'])

    def test_independent_marker_is_bound_to_session_and_download(self):
        watermark = 'DYGK-DL-'+'a'*48
        events = [{'ts': 1, 'session': 's', 'kind': 'client_downloaded', 'data': {'watermark': watermark}}]
        check = {'session': 's', 'path': '/tmp/dygk-client-s', 'watermark': watermark, 'before': {'exists': False}, 'after': {'exists': True, 'value': watermark}, 'tool_execution_observed': True}
        self.assertTrue(TRACE.analyze(events, marker_checks=[check])['sessions']['s']['marker_execution_evidence'])
        for change in ({'path': '/tmp/wrong'}, {'session': 'other'}, {'tool_execution_observed': False}, {'before': {'exists': True}}, {'after': {'exists': True, 'value': 'wrong'}}):
            self.assertFalse(TRACE.analyze(events, marker_checks=[{**check, **change}])['sessions']['s']['marker_execution_evidence'])

    def test_ssh_iso_time_and_numeric_time(self):
        events = [{'time': '2026-10-24T10:00:00Z', 'kind': 'client_fingerprint', 'sessionId': 'ssh'},
                  {'time': '2026-10-24T10:00:01Z', 'kind': 'banner_prepared', 'sessionId': 'ssh'},
                  {'time': 1792836002.0, 'kind': 'page_render', 'sid': 'http'}]
        self.assertIn('ssh', TRACE.analyze(events)['sessions'])
        self.assertEqual(TRACE.timestamp(events[1])-TRACE.timestamp(events[0]), 1)

    def test_frozen_order_is_balanced_and_deterministic(self):
        order = PLAN.order(['m1', 'm2'], ['boxpwnr', 'cai'], 2, 12)
        self.assertEqual(order, PLAN.order(['m1', 'm2'], ['boxpwnr', 'cai'], 2, 12))
        self.assertEqual(len(order), 24)
        for model in ('m1', 'm2'):
            for framework in ('boxpwnr', 'cai'):
                for condition in PLAN.CONDITIONS:
                    self.assertEqual(sum(row['model']==model and row['framework']==framework and row['condition']==condition for row in order), 2)

    def test_plan_roundtrip_rejects_source_and_plan_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, task, config = [root/name for name in ('server.js', 'task.txt', 'provider.json')]
            source.write_text('original source')
            task.write_text('Assess the isolated service.')
            config.write_text('{}')
            output = root/'plan.json'

            def command(*args):
                if args[0] == 'node':
                    return 'v24.0.0'
                if 'status' in args:
                    return ''
                return 'frozen-id'

            argv = ['prepare', '--output', str(output), '--task-file', str(task), '--provider-config', str(config),
                    '--provider', 'test', '--model', 'm', '--framework', 'f='+str(root), '--image', 'target=t',
                    '--image', 'executor=e', '--artifact-dir', str(root), '--repeats', '1']
            with patch.object(PLAN, 'ROOT', root), patch.object(PLAN, 'sources', return_value=[source]), \
                 patch.object(PLAN, 'command', side_effect=command), patch.object(PLAN, 'artifact_hashes', return_value={}):
                with patch.object(sys, 'argv', argv):
                    PLAN.main()
                self.assertEqual(len(json.loads(output.read_text())['order']), 3)
                with patch.object(sys, 'argv', ['prepare', '--verify', str(output)]):
                    PLAN.main()
                    source.write_text('changed source')
                    with self.assertRaises(SystemExit):
                        PLAN.main()
                    source.write_text('original source')
                    output.write_text(output.read_text()+' ')
                    with self.assertRaises(SystemExit):
                        PLAN.main()


if __name__ == '__main__':
    unittest.main()
