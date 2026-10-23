"""Disposable two-network lab; model commands never execute on the host."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time

from seed import request

ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT = ROOT / 'results/business-preflight'
APP = 'nocodb/nocodb@sha256:0002aad78c1d14ffa84f0f922bfb0c0fc4804d5c55b12e0400b4e56a7abe4eb0'
PROXY_ENV = ['-e', 'HTTP_PROXY=', '-e', 'HTTPS_PROXY=', '-e', 'ALL_PROXY=',
             '-e', 'http_proxy=', '-e', 'https_proxy=', '-e', 'all_proxy=']
COMMON = ['--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
          '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777', *PROXY_ENV]


def run(*args, check=True, timeout=60, **kwargs):
    return subprocess.run(args, check=check, timeout=timeout, capture_output=True, text=True, **kwargs)


def docker(*args, **kwargs):
    return run('docker', *args, **kwargs)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def image_id(name):
    return docker('image', 'inspect', name, '--format', '{{.Id}}').stdout.strip()


def build_images():
    dest = PREFLIGHT / 'gateway-build'
    (dest / 'experiments/business').mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'lib', dest / 'lib', dirs_exist_ok=True)
    shutil.copy(ROOT / 'package.json', dest)
    shutil.copy(ROOT / 'experiments/business/gateway.mjs', dest / 'experiments/business')
    shutil.copy(PREFLIGHT / 'fixture.json', dest)
    (dest / 'Dockerfile').write_text('FROM node:24-bookworm-slim\nWORKDIR /lab\nCOPY . /lab/\nCMD ["node","experiments/business/gateway.mjs"]\n')
    app = PREFLIGHT / 'app-build'
    app.mkdir(exist_ok=True)
    shutil.copytree(PREFLIGHT / 'snapshot', app / 'snapshot', dirs_exist_ok=True)
    (app / 'Dockerfile').write_text(f'FROM {APP}\nCOPY snapshot /seed/\nCMD ["sh","-c","cp -R /seed/. /usr/app/data/ && exec /usr/src/appEntry/start.sh"]\n')
    env = dict(os.environ, PATH=os.environ['PATH'] + ':/mnt/c/Program Files/Docker/Docker/resources/bin')
    for directory, tag in [(dest, 'dygk-business-gateway:local'), (app, 'dygk-business-app:local')]:
        result = docker('build', '--network=none', '--pull=false', '-t', tag, str(directory), timeout=180, env=env, check=False)
        (directory / 'build.log').write_text(result.stdout + result.stderr)
        result.check_returncode()
    return {name: image_id(name) for name in ['dygk-business-gateway:local', 'dygk-business-app:local', 'openxdr-decoy-eval:local']}


class Lab:
    def __init__(self, mode, output, images, http_limit=400):
        self.mode, self.output, self.images, self.http_limit = mode, output, images, http_limit
        self.name = 'dygk-biz-' + secrets.token_hex(5)
        self.front, self.back = self.name + '-front', self.name + '-back'
        self.app, self.gateway, self.agent = [self.name + '-' + role for role in ('app', 'gateway', 'agent')]
        self.chain = 'DYGK' + secrets.token_hex(5).upper()
        self.containers, self.networks, self.rules = [], [], []
        output.mkdir(parents=True, exist_ok=True)

    def start(self):
        for network in (self.front, self.back):
            docker('network', 'create', '--internal', network)
            self.networks.append(network)
        for name, network, image, extra in [
            (self.app, self.back, 'dygk-business-app:local', [
                '--network-alias', 'business', '--tmpfs', '/usr/src/app:rw,exec,nosuid,nodev,size=1g,mode=1777',
                '--tmpfs', '/usr/app/data:rw,nosuid,nodev,size=256m,mode=1777',
                '-e', 'NC_DISABLE_TELE=true', '-e', 'NC_PUBLIC_URL=http://target.lab:18092']),
            (self.gateway, self.front, 'dygk-business-gateway:local', [
                '--network-alias', 'target.lab', '--sysctl', 'net.ipv4.ip_forward=0',
                '-e', 'UPSTREAM=http://business:8080', '-e', f'MODE={self.mode}', '-e', f'HTTP_LIMIT={self.http_limit}']),
            (self.agent, self.front, 'openxdr-decoy-eval:local', []),
        ]:
            docker('run', '-d', '--name', name, '--network', network, *COMMON, *extra, self.images[image])
            self.containers.append(name)
        docker('network', 'connect', self.back, self.gateway)
        info = json.loads(docker('inspect', *self.containers).stdout)
        self.app_ip = info[0]['NetworkSettings']['Networks'][self.back]['IPAddress']
        self.gateway_ip = info[1]['NetworkSettings']['Networks'][self.front]['IPAddress']
        self.agent_ip = info[2]['NetworkSettings']['Networks'][self.front]['IPAddress']
        self.host_ip = json.loads(docker('network','inspect',self.front).stdout)[0]['IPAM']['Config'][0]['Gateway']
        self.base = f'http://{self.gateway_ip}:18092'
        run('sudo', '-n', 'iptables', '-N', self.chain)
        self.rules.append(['-X', self.chain])
        run('sudo', '-n', 'iptables', '-A', self.chain, '-d', self.gateway_ip, '-p', 'tcp', '--dport', '18092', '-j', 'ACCEPT')
        run('sudo', '-n', 'iptables', '-A', self.chain, '-j', 'REJECT')
        self.rules.append(['-F', self.chain])
        for chain, target in [('DOCKER-USER', self.chain), ('INPUT', 'REJECT')]:
            rule = ['-s', self.agent_ip, '-j', target]
            run('sudo', '-n', 'iptables', '-I', chain, '1', *rule)
            self.rules.append(['-D', chain, *rule])
        save(self.output / 'isolation.json', [{
            'name': x['Name'], 'user': x['Config']['User'], 'image': x['Image'],
            'readonly': x['HostConfig']['ReadonlyRootfs'], 'mounts': x['Mounts'],
            'cap_drop': x['HostConfig']['CapDrop'], 'security': x['HostConfig']['SecurityOpt'],
            'sysctls': x['HostConfig'].get('Sysctls', {}), 'networks': x['NetworkSettings']['Networks'],
        } for x in info])
        for attempt in range(90):
            try:
                status, body = request(f'http://{self.app_ip}:8080', '/api/v1/health')
                if status == 200:
                    return self
            except OSError:
                pass
            time.sleep(1)
        raise RuntimeError('Application failed readiness')

    def isolation_check(self):
        # No model sees these probes or their output.
        probes = [('gateway', self.gateway_ip, 18092, True), ('backend', self.app_ip, 8080, False),
                  ('host', self.host_ip, 22, False), ('external', '1.1.1.1', 443, False),
                  ('other_gateway_port', self.gateway_ip, 8080, False)]
        code = '''import socket,json,sys
result=[]
for name,host,port,expected in json.loads(sys.argv[1]):
 try:
  with socket.create_connection((host,port),timeout=1): passed=True
 except OSError: passed=False
 result.append(dict(name=name,connected=passed,expected=expected))
print(json.dumps(result))
'''
        result = json.loads(docker('exec', self.agent, 'python3', '-c', code, json.dumps(probes)).stdout)
        assert all(x['connected'] == x['expected'] for x in result), result
        proxy = docker('exec', self.agent, 'sh', '-lc',
                       "env | grep -iE '^(http|https|all)_proxy=.' || true").stdout
        assert not proxy.strip(), proxy
        save(self.output / 'network-check.json', result)
        (self.output / 'proxy-env.txt').write_text(proxy)
        return result

    def collect(self):
        copied=docker('exec', self.gateway, 'cat', '/tmp/events.jsonl', check=False)
        (self.output/'events.jsonl').write_text(copied.stdout)
        if copied.returncode: (self.output/'collection-error.txt').write_text(copied.stderr)
        for name, role in [(self.gateway, 'gateway'), (self.app, 'app')]:
            logs = docker('logs', name, check=False)
            (self.output / f'{role}.log').write_text(logs.stdout + logs.stderr)
        if self.rules:
            (self.output / 'firewall.txt').write_text(run('sudo', '-n', 'iptables', '-nvL', self.chain, check=False).stdout)

    def close(self):
        for name in reversed(self.containers):
            docker('rm', '-f', name, check=False)
        for rule in reversed(self.rules):
            run('sudo', '-n', 'iptables', *rule, check=False)
        for network in reversed(self.networks):
            docker('network', 'rm', network, check=False)


if __name__ == '__main__':
    save(PREFLIGHT / 'images.json', build_images())
    print('Frozen fixture and gateway images built')
