import os
import sys
import json
import pathlib
import threading
import importlib.util

root = pathlib.Path(os.environ.get('DYGK_RESEARCH_ROOT','/home/Kei/ai-pentest-countermeasures'))
sys.path.insert(0,str(root/'scripts'))
from resource_budget_v4 import ResourceRelay
container, out = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
for k in ('ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'):
    os.environ.pop(k, None)
spec = importlib.util.spec_from_file_location('ev', root / 'validation/ssh-decoy/evaluate.py')
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)
ev.MAX_TOKENS = 4096
ev.REQUEST_TIMEOUT = int(os.environ.get('LAB_MODEL_TIMEOUT', '90'))
trace = []
provider = os.environ.get('LAB_PROVIDER', 'glm53-a800')
model = os.environ.get('LAB_MODEL', 'GLM-5.3-Flash')
relay = ResourceRelay(ev.load_provider(provider, model), trace, out / 'model.jsonl')
threading.Thread(target=relay.serve_forever, daemon=True).start()
os.environ.update(
    STRIX_LLM=f'openai/{model}',
    LLM_API_KEY='unused',
    LLM_API_BASE=f'http://127.0.0.1:{relay.server_port}/v1',
    LLM_DISABLE_STREAMING='true',
    LLM_TIMEOUT=str(ev.REQUEST_TIMEOUT),
    STRIX_SANDBOX_IMAGE='ghcr.io/usestrix/strix-sandbox:1.3.0',
)
import docker
from docker.models.containers import Container

original_api_exec = docker.APIClient.exec_create
container_id = docker.from_env().containers.get(container).id
def bounded_api_exec(self, container, cmd, *args, **kw):
    if container not in (container_id, globals()['container']):
        raise RuntimeError('execution outside assigned sandbox')
    if args:
        raise RuntimeError('unexpected positional Docker exec options')
    kw['user']='10001:10001'
    return original_api_exec(self, container, cmd, **kw)
docker.APIClient.exec_create = bounded_api_exec

original_exec = Container.exec_run
original_remove = Container.remove
original_stop = Container.stop
original_kill = Container.kill


def bounded_exec(self, *args, **kw):
    if self.name != container:
        raise RuntimeError('execution outside assigned sandbox')
    kw['user'] = '10001:10001'
    return original_exec(self, *args, **kw)


def remove(self, *a, **k):
    if self.name != container:
        raise RuntimeError('controller cannot remove other containers')
    # 保留 sandbox 到 Lab 完成 marker 检查后再由 Lab 删除。


def stop(self, *a, **k):
    if self.name != container:
        raise RuntimeError('controller cannot stop other containers')
    # 不在这里停止 sandbox；否则 marker 检查会得到 container not running。


def kill(self, *a, **k):
    if self.name != container:
        raise RuntimeError('controller cannot kill other containers')
    # Strix 的 delete 路径会调用 kill；保留 sandbox 供 Lab 检查 marker。


Container.exec_run = bounded_exec
Container.remove = remove
Container.stop = stop
Container.kill = kill
from strix.runtime.docker_client import StrixDockerSandboxClient


async def fixed_container(self, image, **kw):
    return self.docker_client.containers.get(container)


StrixDockerSandboxClient._create_container = fixed_container
(out / 'config.json').write_text('{"env":{}}')
os.chdir(out)
task = os.environ['LAB_TASK']
sys.argv = ['strix', '-n', '-t', os.environ['LAB_TARGET_URL'], '--instruction', task,
            '--scan-mode', 'quick', '--max-turns', '40', '--config', str(out / 'config.json')]
try:
    from strix.interface.main import main
    main()
finally:
    relay.shutdown()
    relay.server_close()
    (out / 'trace.json').write_text(json.dumps(trace, ensure_ascii=False, indent=2))
