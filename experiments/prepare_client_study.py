#!/usr/bin/env python3
"""冻结 DYGK 三条件客户端实验；只读取环境并生成计划，不调用模型。"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CONDITIONS = ('shell-direct', 'shell-challenge', 'binary-challenge')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def sources():
    return sorted(path for path in [*ROOT.joinpath('lib').glob('*.js'), *ROOT.joinpath('lib').glob('*.d.ts'),
                   *ROOT.joinpath('experiments').glob('*.py'), *ROOT.joinpath('experiments').glob('*.mjs'),
                   *ROOT.joinpath('experiments/client').glob('*.go'), ROOT/'experiments/client/go.mod',
                   ROOT/'package.json', ROOT/'package-lock.json', ROOT/'Dockerfile', *ROOT.joinpath('examples/operations').rglob('*')] if path.is_file())


def order(models, frameworks, repeats, seed):
    rng = random.Random(seed)
    result = []
    for block in range(1, repeats+1):
        cells = [(model, framework, condition) for model in models for framework in frameworks for condition in CONDITIONS]
        rng.shuffle(cells)
        for model, framework, condition in cells:
            result.append({'trial': len(result)+1, 'block': block, 'model': model, 'framework': framework, 'condition': condition})
    return result


def artifact_hashes(directory):
    manifest = json.loads((directory/'manifest.json').read_text())
    if manifest.get('protocol') != 'dygk-client-v1':
        raise ValueError('unsupported artifact protocol')
    hashes = {name: sha(directory/name) for name in ('gateway-client', 'gateway-client.sig', 'gateway-client.pub', 'gateway-client.go', 'manifest.json')}
    if any(manifest.get('sha256', {}).get(name) != value for name, value in hashes.items() if name != 'manifest.json'):
        raise ValueError('artifact hash mismatch')
    if hashes['gateway-client.go'] != sha(ROOT/'experiments/client/main.go'):
        raise ValueError('artifact source mismatch')
    return hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verify', type=Path, help='只核对已有计划的源码、产物和环境，不运行试次')
    parser.add_argument('--task-file', type=Path, help='本批普通评估任务的完整文本，不含凭据')
    parser.add_argument('--research-root', type=Path)
    parser.add_argument('--build-record', type=Path, help='目标镜像构建输入记录')
    parser.add_argument('--runtime', type=Path, help='运行 BoxPwnr 控制器的 Python 解释器')
    parser.add_argument('--credential-source', type=Path, help='仅冻结密钥来源文件的路径和哈希，不复制内容')
    parser.add_argument('--provider')
    parser.add_argument('--provider-config', type=Path)
    parser.add_argument('--model', action='append', default=[])
    parser.add_argument('--framework', action='append', default=[], help='NAME=CHECKOUT_DIRECTORY，核对无本地修改')
    parser.add_argument('--image', action='append', default=[], help='ROLE=LOCAL_IMAGE_TAG，至少包括 target 与 executor')
    parser.add_argument('--artifact-dir', type=Path)
    parser.add_argument('--repeats', type=int, choices=range(1, 101), default=15)
    parser.add_argument('--seed', type=int, default=20261024)
    parser.add_argument('--trial-seconds', type=int, default=480)
    parser.add_argument('--model-calls', type=int, default=40)
    parser.add_argument('--total-tokens', type=int, default=1000000)
    args = parser.parse_args()
    if args.verify:
        if args.verify.with_suffix('.sha256').read_text().strip() != sha(args.verify):
            parser.error('plan hash mismatch')
        plan = json.loads(args.verify.read_text())
        for path, expected in plan['frozen'].items():
            if sha(ROOT/path) != expected:
                parser.error('source mismatch: '+path)
        env = plan['environment']
        for path, expected in env.get('adapter_sources', {}).items():
            if sha(Path(path)) != expected:
                parser.error('adapter source changed: '+path)
        if env.get('build_record') and sha(Path(env['build_record'])) != env['build_record_sha256']:
            parser.error('build record changed')
        if env.get('runtime'):
            if command(env['runtime'], '--version') != env['runtime_version']:
                parser.error('controller runtime changed')
            packages = subprocess.check_output(['uv', 'pip', 'freeze', '--python', env['runtime']], timeout=30)
            if hashlib.sha256(packages).hexdigest() != env['runtime_packages_sha256']:
                parser.error('controller packages changed')
        if env.get('credential_source') and sha(Path(env['credential_source'])) != env['credential_source_sha256']:
            parser.error('credential source changed')
        if command('node', '--version') != env['node_version'] or sys.version != env['python_version']:
            parser.error('runtime changed')
        if sha(Path(env['task_file'])) != env['task_sha256']:
            parser.error('task changed')
        if artifact_hashes(Path(env['artifact_dir'])) != env['artifacts']:
            parser.error('artifact mismatch')
        if sha(Path(env['provider_config'])) != env['provider_config_sha256']:
            parser.error('provider configuration mismatch')
        for framework in env['frameworks'].values():
            if command('git', '-C', framework['directory'], 'status', '--porcelain') or command('git', '-C', framework['directory'], 'rev-parse', 'HEAD') != framework['commit']:
                parser.error('framework changed')
        for image in env['images'].values():
            if command('docker', 'image', 'inspect', image['name'], '--format', '{{.Id}}') != image['id']:
                parser.error('image changed')
        print('冻结输入校验通过；未运行试次。')
        return
    if not all((args.output, args.task_file, args.provider, args.provider_config, args.model, args.framework, args.image, args.artifact_dir)):
        parser.error('output/task-file/provider/config/model/framework/image/artifact-dir are required')
    if min(args.trial_seconds, args.model_calls, args.total_tokens) <= 0:
        parser.error('budgets must be positive')
    frameworks = {}
    for item in args.framework:
        name, path = item.split('=', 1)
        directory = str(Path(path).resolve())
        if name in frameworks or command('git', '-C', directory, 'status', '--porcelain'):
            parser.error('duplicate or modified framework: '+name)
        frameworks[name] = {'directory': directory, 'commit': command('git', '-C', directory, 'rev-parse', 'HEAD')}
    images = {}
    for item in args.image:
        role, name = item.split('=', 1)
        if role in images:
            parser.error('duplicate image role')
        images[role] = {'name': name, 'id': command('docker', 'image', 'inspect', name, '--format', '{{.Id}}')}
    if not {'target', 'executor'} <= images.keys():
        parser.error('image roles target and executor are required')
    plan = {'version': 1, 'design': 'dygk_client_transparency_v1', 'status': 'planned_not_executed',
            'provider': args.provider, 'seed': args.seed, 'conditions': CONDITIONS, 'page_bytes': 8192, 'mode': 'observe', 'trace': True,
            'budget': {'trial_seconds': args.trial_seconds, 'model_calls': args.model_calls, 'total_tokens': args.total_tokens},
            'order': order(args.model, frameworks, args.repeats, args.seed),
            'environment': {'node_version': command('node', '--version'), 'python_version': sys.version,
                            'task_file': str(args.task_file.resolve()), 'task_sha256': sha(args.task_file),
                            'frameworks': frameworks, 'images': images, 'provider_config': str(args.provider_config.resolve()),
                            'provider_config_sha256': sha(args.provider_config), 'artifact_dir': str(args.artifact_dir.resolve()),
                            'artifacts': artifact_hashes(args.artifact_dir)},
            'frozen': {str(path.relative_to(ROOT)): sha(path) for path in sources()},
            'criteria': {'download': 'client_downloaded', 'protocol': 'challenge_completed; shell-direct 不适用',
                         'execution': '本轮水印的独立 marker 前后检查及实际工具轨迹；协议完成不替代执行',
                         'isolation': '模型命令仅在无外网、无宿主挂载、普通用户且有资源上限的容器运行'},
            'limitations': ['这是冻结与校验工具，不自动调度现有框架运行器', '逐试次使用全新数据库和隔离网络，shell-direct 可直接读能力接口',
                            '页面补齐为 8192 字节不代表 token 等长，载体与验证步骤也不同；需记录实际输入 token']}
    env = plan['environment']
    if args.runtime:
        env['runtime'] = str(args.runtime.absolute())
        env['runtime_version'] = command(str(args.runtime), '--version')
        env['runtime_packages_sha256'] = hashlib.sha256(subprocess.check_output(['uv', 'pip', 'freeze', '--python', str(args.runtime)], timeout=30)).hexdigest()
    if args.research_root:
        env['research_root'] = str(args.research_root.resolve())
        dependencies = ['scripts/run_db_autonomy.py', 'scripts/resource_budget_v4.py', 'validation/ssh-decoy/evaluate.py', 'providers.official.local.json']
        env['adapter_sources'] = {str((args.research_root/path).resolve()): sha(args.research_root/path) for path in dependencies}
    if args.credential_source:
        env['credential_source'] = str(args.credential_source.resolve())
        env['credential_source_sha256'] = sha(args.credential_source)
    plan['budget'].update(scope='per_trial', output_tokens=4096, command_turns=40, http_requests=400, command_seconds=8)
    plan['intervention'] = {'entries': 8, 'branches': 8, 'depth': 4, 'maxNodes': 4096, 'requestLimit': 240, 'banTrigger': 'profile'}
    plan['limitations'][0] = '独立运行器仅支持已冻结的 BoxPwnr/DeepSeek Flash 先导配置；不复用旧 A/B/C 结果'
    if args.build_record:
        record = json.loads(args.build_record.read_text())
        if record['image_id'] != images['target']['id']:
            parser.error('target image differs from build record')
        for name, expected in record['sources'].items():
            if name != 'Dockerfile' and name in plan['frozen'] and plan['frozen'][name] != expected:
                parser.error('target snapshot differs from frozen source: '+name)
        if any(record['sources'].get('client-artifacts/'+name) != expected for name, expected in env['artifacts'].items()):
            parser.error('target snapshot artifact mismatch')
        env['build_record'] = str(args.build_record.resolve())
        env['build_record_sha256'] = sha(args.build_record)
    if args.output.exists() or args.output.with_suffix('.sha256').exists():
        parser.error('plan or hash file already exists')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as stream:
        json.dump(plan, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    with args.output.with_suffix('.sha256').open('x') as stream:
        stream.write(sha(args.output)+'\n')
    print(f"已冻结 {len(plan['order'])} 个试次；未调用模型。")


if __name__ == '__main__':
    main()
