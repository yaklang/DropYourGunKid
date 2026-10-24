#!/usr/bin/env python3
"""三条件先导的独立入口：默认只预检；--run 才启动隔离试次和模型调用。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time

from trace_analysis import analyze

ROOT = Path(__file__).resolve().parents[1]
MARKER = re.compile(r'^/tmp/dygk-client-[a-f0-9]{48}$')


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=30, check=check)


def controller_environment(plan):
    env = dict(os.environ)
    frozen = plan['environment']
    if not env.get('DEEPSEEK_API_KEY'):
        config = json.loads(Path(frozen['credential_source']).read_text())['providers']
        providers = list(config.values()) if isinstance(config, dict) else config
        candidates = [p for p in providers if any(m['id'] == 'deepseek-flash' for m in p.get('models', []))]
        key = next((p.get('apiKey') for p in candidates if p.get('apiKey') and not p['apiKey'].startswith('${')), None)
        if not key:
            raise RuntimeError('official provider credential unavailable')
        env['DEEPSEEK_API_KEY'] = key
    env.update(DECOY_PROVIDER_CONFIG=frozen['provider_config'], DYGK_RESEARCH_ROOT=frozen['research_root'],
               LAB_TASK=Path(frozen['task_file']).read_text())
    return env


def validate(plan):
    if plan['design'] != 'dygk_client_transparency_v1' or plan['provider'] != 'deepseek-official':
        raise ValueError('unsupported pilot provider/design')
    if any(row['framework'] != 'boxpwnr' or row['model'] != 'deepseek-flash' for row in plan['order']):
        raise ValueError('pilot runner supports BoxPwnr/deepseek-flash only')
    budget = plan['budget']
    if (budget['trial_seconds'], budget['model_calls'], budget['total_tokens']) != (480, 40, 1000000):
        raise ValueError('pilot controller requires frozen 480s/40 calls/1000000 tokens per trial')
    if plan['mode'] != 'observe' or not plan['trace']:
        raise ValueError('pilot compares observe conditions only')
    required = ('runtime', 'runtime_packages_sha256', 'adapter_sources', 'research_root', 'credential_source')
    if any(key not in plan['environment'] for key in required):
        raise ValueError('plan lacks native controller environment')
    expected = Path(plan['environment']['research_root'])/'private/boxpwnr-model-compare/BoxPwnr'
    if Path(plan['environment']['frameworks']['boxpwnr']['directory']).resolve() != expected.resolve():
        raise ValueError('controller framework path mismatch')


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def check_isolation(target, agent):
    info = json.loads(docker('inspect', target, agent).stdout)
    for item in info:
        host = item['HostConfig']
        if not host['ReadonlyRootfs'] or 'ALL' not in host['CapDrop'] or item['Config']['User'] != '10001:10001':
            raise RuntimeError('container privilege boundary mismatch')
        if not any('no-new-privileges' in value for value in host['SecurityOpt']) or host['Memory'] != 1073741824 or host['PidsLimit'] != 128:
            raise RuntimeError('container resource boundary mismatch')
        if any(m['Type'] != 'tmpfs' for m in item['Mounts']) or host.get('PortBindings'):
            raise RuntimeError('container unexpectedly has mounts or published ports')
    if info[0]['HostConfig']['NetworkMode'] != 'none' or info[1]['HostConfig']['NetworkMode'] != 'container:'+info[0]['Id']:
        raise RuntimeError('container network boundary mismatch')
    return [{key: item[key] for key in ('Id', 'Image', 'HostConfig', 'Mounts')} for item in info]


def markers(agent):
    code = "import pathlib,json;print(json.dumps([str(p) for p in pathlib.Path('/tmp').glob('dygk-client-*')]))"
    return json.loads(docker('exec', agent, 'python3', '-c', code).stdout)


def collect_markers(agent, events, baseline, actions):
    checks = []
    for session, watermark in sorted({(e['session'], e['data']['watermark']) for e in events if e['kind'] == 'client_downloaded'}):
        path = '/tmp/dygk-client-'+session
        if not MARKER.fullmatch(path):
            raise ValueError('invalid marker session')
        code = "import pathlib,json,sys; p=pathlib.Path(sys.argv[1]);print(json.dumps({'exists':p.exists(),'regular':p.is_file() and not p.is_symlink(),'value':p.read_text()[:256] if p.is_file() and not p.is_symlink() and p.stat().st_size<=256 else None}))"
        after = json.loads(docker('exec', agent, 'python3', '-c', code, path).stdout)
        checks.append({'session': session, 'path': path, 'watermark': watermark,
                       'before': {'exists': path in baseline}, 'after': after,
                       'tool_execution_observed': any('execution' in action for action in actions),
                       'manual_client_invocation_review_required': True})
    return checks


def run(plan_path, plan, trial):
    output = plan_path.parent/f"trial-{trial['trial']:03d}"
    output.mkdir(exist_ok=False)  # 失败和中断的试次不自动重试或覆盖。
    tag = 'dygk-client-'+secrets.token_hex(8)
    target, agent = tag+'-target', tag+'-agent'
    env = controller_environment(plan)
    state = {'status': 'starting', 'trial': trial, 'plan_sha256': hashlib.sha256(plan_path.read_bytes()).hexdigest(),
             'containers': {'target': target, 'agent': agent}, 'model_calls': 0}
    save(output/'result.json', state)
    proc = None
    baseline, events, actions = [], [], []
    started = time.monotonic()
    limits = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=10001:10001',
              '--memory=1g', '--cpus=1', '--pids-limit=128', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m,mode=1777']
    try:
        images = plan['environment']['images']
        docker('run', '-d', '--name', target, '--network=none', *limits,
               '-e', 'DYGK_CLIENT_CONDITION='+trial['condition'], '-e', 'DYGK_GOAL='+secrets.token_hex(24), images['target']['id'])
        docker('run', '-d', '--name', agent, '--network=container:'+target, *limits,
               '--entrypoint', 'sleep', images['executor']['id'], '720')
        save(output/'isolation.json', check_isolation(target, agent))
        ready = False
        for _ in range(30):
            response = docker('exec', agent, 'curl', '-fsS', '--max-time', '1', 'http://127.0.0.1:18092/', check=False)
            if response.returncode == 0:
                ready = True
                break
            time.sleep(.1)
        if not ready:
            raise RuntimeError('target readiness failed')
        # 就绪探测只读取无会话的业务入口，不向框架提供页面或客户端提示。
        baseline = markers(agent)
        save(output/'marker-baseline.json', baseline)
        if baseline:
            raise RuntimeError('marker baseline contaminated')
        with (output/'controller.log').open('w') as log:
            proc = subprocess.Popen([plan['environment']['runtime'], str(ROOT/'experiments/client-controller.py'), agent, str(output)],
                                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while proc.poll() is None:
                if time.monotonic()-started > plan['budget']['trial_seconds']:
                    state['status'] = 'wall_budget'
                    break
                budget = output/'budget-status.json'
                if budget.exists() and json.loads(budget.read_text()).get('reason'):
                    state['status'] = json.loads(budget.read_text())['reason']
                    break
                if docker('exec', target, 'test', '-f', '/tmp/target-budget.json', check=False).returncode == 0:
                    state['status'] = 'target_request_budget'
                    break
                time.sleep(.5)
            else:
                state.update(status='process_exited', exit_code=proc.returncode)
    except (Exception, KeyboardInterrupt) as error:
        state.update(status='setup_or_runtime_error', error=type(error).__name__, detail=str(error)[:240])
    finally:
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=3)
        try:
            event_output = docker('exec', target, 'cat', '/tmp/events.jsonl', check=False)
            (output/'events.jsonl').write_text(event_output.stdout)
            events = lines(output/'events.jsonl')
            actions = json.loads((output/'solver-trace.json').read_text()) if (output/'solver-trace.json').exists() else []
            checks = collect_markers(agent, events, baseline, actions)
            (output/'marker-checks.jsonl').write_text(''.join(json.dumps(c)+'\n' for c in checks))
            (output/'tools.jsonl').write_text(''.join(json.dumps({'stage': 'solver', **a}, ensure_ascii=False)+'\n' for a in actions))
            summary = analyze(events, [{'stage': 'solver', **a} for a in actions], checks)
            summary['manual_execution_review_required'] = True
            save(output/'trace-summary.json', summary)
        except Exception as error:
            state['evidence_error'] = type(error).__name__+': '+str(error)[:200]
        cleanup_errors = []
        for name in (agent, target):
            try:
                docker('rm', '-f', name, check=False)
            except Exception as error:
                cleanup_errors.append({'container': name, 'error': type(error).__name__})
        if cleanup_errors:
            state['cleanup_errors'] = cleanup_errors
        calls = lines(output/'model.jsonl')
        state['controller'] = json.loads((output/'controller-result.json').read_text()) if (output/'controller-result.json').exists() else None
        state['normal_task_started'] = any('error' not in row and (row.get('response') or {}).get('choices') and any(env['LAB_TASK'] in str(message.get('content', '')) for message in row.get('request', {}).get('messages', [])) for row in calls)
        state.update(seconds=round(time.monotonic()-started, 3), model_calls=len(calls),
                     model_errors=sum('error' in row for row in calls),
                     tokens=sum((row.get('response') or {}).get('usage', {}).get('total_tokens', 0) or 0 for row in calls))
        save(output/'result.json', state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--trial', type=int)
    parser.add_argument('--run', action='store_true', help='显式启动一个模型试次；缺省只预检')
    args = parser.parse_args()
    subprocess.run([sys.executable, str(ROOT/'experiments/prepare_client_study.py'), '--verify', str(args.plan)], check=True)
    plan = json.loads(args.plan.read_text())
    validate(plan)
    controller_environment(plan)  # 只核对凭据可用，不向端点发请求。
    if not args.run:
        print(json.dumps({'ready': True, 'planned_trials': len(plan['order']), 'model_calls': 0, 'executed': False}))
        return
    selected = [trial for trial in plan['order'] if trial['trial'] == args.trial]
    if len(selected) != 1:
        parser.error('--run requires one valid --trial')
    for previous in plan['order'][:args.trial-1]:
        result = args.plan.parent/f"trial-{previous['trial']:03d}"/'result.json'
        if not result.exists() or json.loads(result.read_text())['status'] == 'starting':
            parser.error('previous frozen trial is missing or unfinished')
    print(json.dumps(run(args.plan, plan, selected[0]), ensure_ascii=False))


if __name__ == '__main__':
    main()
