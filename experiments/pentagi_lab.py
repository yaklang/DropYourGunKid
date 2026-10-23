"""PentAGI原生流程接入；Docker代理只管理本轮受限worker。"""
import json
import subprocess
import time
import uuid
from pathlib import Path
from restricted_docker_lab import RestrictedDocker, SERVER


def augment_bridge(bridge, research):
    embed=(research/'scripts/adapters/pentagi_embed.py').read_text()
    broker=SERVER.replace('("127.0.0.1",18094)', '("0.0.0.0",18094)')
    launch='threading.Thread(target=lambda:exec('+repr(broker)+',{}),daemon=True).start()\n'
    launch+='threading.Thread(target=lambda:exec('+repr(embed)+',{}),daemon=True).start()\n'
    endpoint="http.server.ThreadingHTTPServer(('0.0.0.0',18093),Bridge).serve_forever()"
    if bridge.count(endpoint)!=1:raise ValueError("model bridge insertion point missing")
    return bridge.replace(endpoint,launch+endpoint)


def create_pentagi_lab(parent, base, images):
    docker=base.runner.lab.docker
    class PentagiLab(parent):
        def prepare(self):
            super().prepare()
            self.broker=RestrictedDocker(self.target,images['vxcontrol/kali-linux:latest'],marker=self.marker_name)
            for _ in range(20):
                check=docker('exec',self.target,'python3','-c',"import urllib.request; urllib.request.urlopen('http://target.lab:18094/info',timeout=2).read()",check=False)
                if check.returncode==0:break
                time.sleep(.2)
            else:raise RuntimeError('restricted Docker bridge readiness failed')
            pg='autonomy-pg-'+uuid.uuid4().hex[:10]
            self.children.append(pg)
            docker('run','-d','--name',pg,'--network','container:'+self.target,
                   '--user','postgres','--cap-drop=ALL','--security-opt=no-new-privileges',
                   '--read-only','--memory=512m','--cpus=1','--pids-limit=64',
                   '--tmpfs','/tmp:rw,size=128m,mode=1777',
                   '--tmpfs','/var/lib/postgresql/data:rw,size=128m,mode=1777',
                   '--tmpfs','/var/run/postgresql:rw,size=8m,mode=1777',
                   '-e','PGDATA=/tmp/pgdata','-e','POSTGRES_HOST_AUTH_METHOD=trust',
                   '-e','POSTGRES_DB=pentagidb',images['vxcontrol/pgvector:latest'])
            for _ in range(40):
                if docker('exec',pg,'pg_isready',check=False).returncode==0:break
                time.sleep(.5)
            else:raise RuntimeError('PentAGI database readiness failed')
            self.backendlog=(self.output/'backend.log').open('w')
            args=['docker','exec']
            for key,value in self.env.items():args += ['-e',key+'='+value]
            self.backend=subprocess.Popen(args+[self.agent,'/opt/pentagi/bin/pentagi'],stdout=self.backendlog,stderr=subprocess.STDOUT)

        def run(self, controller=None):
            try:return super().run(controller)
            finally:
                if hasattr(self,'backend'):
                    try:self.backend.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.backend.terminate();self.backend.wait(timeout=5)
                    self.backendlog.close()
    return PentagiLab


def run_pentagi(cls, base, root, research, out, mode, task, options):
    provider=(research/'scripts/adapters/pentagi_provider.yml').read_text().replace('GLM-5.3-Flash',options.model)
    image=base.runner.lab.build('vxcontrol/pentagi:latest',out/(mode+'-agent-build'),{'provider.yml':provider})
    env=dict(DATABASE_URL='postgres://postgres@target.lab:5432/pentagidb?sslmode=disable',
      SERVER_HOST='0.0.0.0',SERVER_PORT='8080',SERVER_USE_SSL='false',
      DATA_DIR='/tmp/data',STATIC_DIR='/opt/pentagi/fe',DOCKER_HOST='tcp://target.lab:18094',DOCKER_INSIDE='false',
      LLM_SERVER_URL='http://llm.lab:18093/v1',LLM_SERVER_KEY='unused',LLM_SERVER_MODEL=options.model,LLM_SERVER_CONFIG_PATH='/lab/provider.yml',
      EMBEDDING_URL='http://target.lab:18081/v1',EMBEDDING_KEY='unused',EMBEDDING_MODEL='fake-embed-1536')
    lab=cls(out/('pentagi-'+mode),'pentagi',image,['native-api-controller'],entry='controller',env=env,
        task=task,source=options.source,marker=options.marker,seconds=480,internal_network=True,
        model=options.model,provider=options.provider,model_call_limit=40,model_timeout=90)
    control='''import urllib.request,http.cookiejar,json,time,pathlib
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path,data=None):
    req=urllib.request.Request(URL+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
    with op.open(req,timeout=30) as res:return json.load(res)
for _ in range(80):
    try:call('/api/v1/info');break
    except Exception:time.sleep(.5)
else:raise RuntimeError('PentAGI backend readiness failed')
call('/api/v1/auth/login',{'mail':'admin@pentagi.com','password':'admin'})
f=call('/api/v1/flows/',{'input':TASK,'provider':'custom'})
fid=f['data']['id'];print('FLOW_ID',fid,flush=True)
for _ in range(96):
    time.sleep(5)
    result=call('/api/v1/flows/%d'%fid)
    pathlib.Path('/tmp/pentagi-flow.json').write_text(json.dumps(result))
    status=result.get('data',{}).get('status')
    print('FLOW_STATUS',status,flush=True)
    if status in ('finished','failed'):
        print('FLOW_RESULT',json.dumps(result),flush=True)
        if status=='failed':raise RuntimeError('PentAGI flow failed')
        break
else:raise RuntimeError('PentAGI controller polling budget')
'''
    control='URL='+repr('http://'+lab.agent+':8080')+'\nTASK='+repr(task)+'\n'+control
    (lab.output/'controller.py').write_text(control)
    # 流程状态由目标容器写入，保存在原始日志；外层负责统一预算和清理。
    return lab.run(lambda a:['docker','exec',a.target,'python3','-c',control])
