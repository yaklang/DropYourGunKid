#!/usr/bin/env python3
"""Rebuild the synthetic NocoDB snapshot and local gateway/application images."""
import json
import shutil
import subprocess
import sys
import tarfile
import time

from lab import APP, COMMON, PREFLIGHT, ROOT, build_images, docker, save
from seed import request

NAME = 'dygk-business-seed'
NET = 'dygk-business-preflight'


def main():
    docker('rm', '-f', NAME, check=False)
    docker('network', 'rm', NET, check=False)
    docker('network', 'create', '--internal', NET)
    docker('run', '-d', '--name', NAME, '--network', NET, *COMMON,
           '--tmpfs', '/usr/src/app:rw,exec,nosuid,nodev,size=1g,mode=1777',
           '--tmpfs', '/usr/app/data:rw,nosuid,nodev,size=256m,mode=1777',
           '-e', 'NC_DISABLE_TELE=true', '-e', 'NC_PUBLIC_URL=http://target.lab:18092', APP)
    try:
        info = json.loads(docker('inspect', NAME).stdout)
        address = info[0]['NetworkSettings']['Networks'][NET]['IPAddress']
        base = f'http://{address}:8080'
        for _ in range(90):
            try:
                if request(base, '/api/v1/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError('NocoDB did not become ready')
        subprocess.run([sys.executable, str(ROOT / 'experiments/business/seed.py'), base, str(PREFLIGHT)], check=True)
        docker('exec', NAME, 'sh', '-c', 'kill -STOP $(pidof node)')
        try:
            with (PREFLIGHT / 'snapshot.tar').open('wb') as stream:
                subprocess.run(['docker', 'exec', NAME, 'tar', '-C', '/usr/app/data', '-cf', '-', '.'],
                               stdout=stream, check=True)
        finally:
            docker('exec', NAME, 'sh', '-c', 'kill -CONT $(pidof node)', check=False)
        if (PREFLIGHT / 'snapshot').exists():
            shutil.rmtree(PREFLIGHT / 'snapshot')
        (PREFLIGHT / 'snapshot').mkdir()
        with tarfile.open(PREFLIGHT / 'snapshot.tar') as archive:
            archive.extractall(PREFLIGHT / 'snapshot', filter='data')
        for path in (PREFLIGHT / 'app-build', PREFLIGHT / 'gateway-build'):
            if path.exists():
                shutil.rmtree(path)
        save(PREFLIGHT / 'images.json', build_images())
        print('Prepared fixture, snapshot and images')
    finally:
        docker('rm', '-f', NAME, check=False)
        docker('network', 'rm', NET, check=False)


if __name__ == '__main__':
    main()
