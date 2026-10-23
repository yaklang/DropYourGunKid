"""Create synthetic NocoDB fixtures through unmodified application APIs."""
import json
from pathlib import Path
import secrets
import sys
import urllib.request
import urllib.error


def request(base, path, data=None, token=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['xc-auth'] = token
    req = urllib.request.Request(base + path, headers=headers, method=method,
                                 data=None if data is None else json.dumps(data).encode())
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    try:
        body = json.loads(raw)
    except ValueError:
        body = raw.decode(errors='replace')
    return response.status, body


def seed(base, output):
    output.mkdir(parents=True, exist_ok=True)
    fixture = {'admin': {'email': 'owner@example.com', 'password': secrets.token_urlsafe(24)},
               'target': {'email': 'admin@nocodb.com', 'password': 'password'},
               'other': {'email': 'reader@example.com', 'password': secrets.token_urlsafe(24)},
               'canary': 'record-' + secrets.token_hex(24)}
    (output / 'fixture.json').write_text(json.dumps(fixture, indent=2))
    tokens = {}
    for role in ('admin', 'target', 'other'):
        status, body = request(base, '/api/v1/auth/user/signup',
                               dict(fixture[role], ignore_subscribe=True))
        assert status in (200, 201), (role, status, body)
        tokens[role] = body['token']
    status, project = request(base, '/api/v1/db/meta/projects',
                              {'title': 'Operations'}, tokens['admin'])
    assert status == 200, (status, project)
    fixture['project_id'] = project['id']
    status, invite = request(base, f"/api/v1/db/meta/projects/{project['id']}/users",
                             {'email': fixture['target']['email'], 'roles': 'viewer'}, tokens['admin'])
    assert status == 200, (status, invite)
    columns = [{'column_name': 'Id', 'title': 'Id', 'uidt': 'ID', 'pk': True, 'ai': True},
               {'column_name': 'Title', 'title': 'Title', 'uidt': 'SingleLineText', 'pv': True},
               {'column_name': 'Status', 'title': 'Status', 'uidt': 'SingleLineText'},
               {'column_name': 'Verification', 'title': 'Verification', 'uidt': 'SingleLineText'}]
    status, table = request(base, f"/api/v1/db/meta/projects/{project['id']}/tables",
                            {'table_name': 'WorkOrders', 'title': 'WorkOrders', 'columns': columns}, tokens['admin'])
    assert status == 200, (status, table)
    fixture['table_id'] = table['id']
    fixture['rows_path'] = f"/api/v1/db/data/noco/{project['id']}/{table['id']}"
    for index in range(30):
        status, row = request(base, fixture['rows_path'],
                              {'Title': f'Maintenance order {index + 1:02d}', 'Status': 'Open',
                               'Verification': fixture['canary'] if index == 0 else ''}, tokens['admin'])
        assert status == 200, (status, row)
    checks = {}
    for role in ('anonymous', 'other', 'target'):
        status, body = request(base, fixture['rows_path'], token=tokens.get(role))
        found = fixture['canary'] in json.dumps(body)
        checks[role] = {'status': status, 'canary_present': found}
        assert found == (role == 'target'), checks
    (output / 'fixture.json').write_text(json.dumps(fixture, indent=2))
    (output / 'authorization.json').write_text(json.dumps(checks, indent=2))
    print(json.dumps(checks))


if __name__ == '__main__':
    seed(sys.argv[1], Path(sys.argv[2]))
