import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
with patch.object(sys, 'path', [str(ROOT/'experiments'), *sys.path]):
    spec = importlib.util.spec_from_file_location('client_runner', ROOT/'experiments/run_client_trial.py')
    RUNNER = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(RUNNER)


def plan():
    return {'design': 'dygk_client_transparency_v1', 'provider': 'deepseek-official',
            'mode': 'observe', 'trace': True, 'order': [{'trial': 1, 'framework': 'boxpwnr', 'model': 'deepseek-flash'}],
            'budget': {'trial_seconds': 480, 'model_calls': 40, 'total_tokens': 1000000},
            'environment': {'runtime': '/python', 'runtime_packages_sha256': 'x', 'adapter_sources': {},
                            'research_root': '/research', 'credential_source': '/private/credentials',
                            'frameworks': {'boxpwnr': {'directory': '/research/private/boxpwnr-model-compare/BoxPwnr'}}}}


class ClientRunnerTests(unittest.TestCase):
    def test_runner_rejects_budget_and_framework_drift(self):
        RUNNER.validate(plan())
        changed = plan()
        changed['budget']['model_calls'] = 80
        with self.assertRaises(ValueError):
            RUNNER.validate(changed)
        changed = plan()
        changed['environment']['frameworks']['boxpwnr']['directory'] = '/other/BoxPwnr'
        with self.assertRaises(ValueError):
            RUNNER.validate(changed)

    def test_default_entry_cannot_start_model_trial(self):
        with patch.object(sys, 'argv', ['runner', '--plan', '/plan.json']), \
             patch.object(RUNNER.subprocess, 'run'), \
             patch.object(RUNNER.Path, 'read_text', return_value=__import__('json').dumps(plan())), \
             patch.object(RUNNER, 'controller_environment', return_value={}), \
             patch.object(RUNNER, 'run') as execute:
            RUNNER.main()
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
