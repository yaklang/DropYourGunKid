import json
import sys
import re
from pathlib import Path
from lab import Lab, PREFLIGHT, run, docker, save
from seed import request

images=json.loads((PREFLIGHT/'images.json').read_text())
mode=sys.argv[1] if len(sys.argv)>1 else 'block'
lab=Lab(mode,PREFLIGHT/('browser-'+mode),images,http_limit=2000)
try:
    lab.start()
    print(lab.isolation_check(),flush=True)
    result=run('node','experiments/business/browser.mjs',lab.base,str(lab.output),timeout=120,check=False)
    print(result.stdout,result.stderr,flush=True)
    result.check_returncode()
    fixture=json.loads((PREFLIGHT/'fixture.json').read_text())
    checks={}
    status,html=request(lab.base,'/dashboard/')
    checks['raw_html_injection']=('data-dygk="1"' in html)
    assert checks['raw_html_injection']==(mode=='block')
    for role in ('anonymous','other','target'):
        token=None
        if role!='anonymous':
            status,login=request(lab.base,'/api/v1/auth/user/signin',fixture[role])
            assert status==200
            token=login['token']
        status,body=request(lab.base,fixture['rows_path'],token=token)
        checks[role]={'status':status,'canary_present':fixture['canary'] in json.dumps(body)}
        assert checks[role]['canary_present']==(role=='target')
    if mode=='block':
        status,html=request(lab.base,'/_dygk/entry/0')
        session=re.search(r'\?s=([a-f0-9]+)',html)[1]
        status,html=request(lab.base,'/_dygk/verify?s='+session)
        csrf=re.search(r'name="csrf" value="([a-f0-9]+)"',html)[1]
        status,body=request(lab.base,'/_dygk/profile?s='+session,
            {'csrf':csrf,'access_key':'compat-'+session[:12],'framework':'functional-preflight','version':'1'})
        assert status==200
        checks['blocked_business_status']=request(lab.base,fixture['rows_path'],token=token)[0]
        checks['blocked_static_status']=request(lab.base,'/dashboard/')[0]
        assert checks['blocked_business_status']==checks['blocked_static_status']==403
    save(lab.output/'acceptance.json',checks)
    print('Application and gateway acceptance passed',flush=True)
finally:
    lab.collect()
    lab.close()
