"""015独立预算副本：60次调用、150万累计Token；保留原版014证据。"""
"""单会话共享预算；串行上游请求，保留排队、实际 usage 和停止原因。"""
import json
import copy
from pathlib import Path
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Budget:
    def __init__(self, provider, output):
        self.provider, self.output = provider, Path(output)
        self.lock = threading.Lock()
        self.calls = self.tokens = 0
        self.reason = None
        self.reasoning_cache = {}

    @staticmethod
    def call_key(call):
        function=call.get('function',{})
        args=function.get('arguments')
        try:args=json.loads(args)
        except (ValueError,TypeError):pass
        return json.dumps([call.get('id'),call.get('type'),function.get('name'),args],sort_keys=True,ensure_ascii=False)

    def restore_reasoning(self, body):
        body=copy.deepcopy(body);restored=[]
        for index,message in enumerate(body.get('messages',[])):
            if message.get('role')!='assistant' or not message.get('tool_calls') or message.get('reasoning_content') is not None:
                continue
            keys=[self.call_key(c) for c in message['tool_calls']]
            if any(k not in self.reasoning_cache for k in keys):
                raise ValueError('missing_original_reasoning')
            values={self.reasoning_cache[k] for k in keys}
            if len(values)!=1:
                raise ValueError('ambiguous_original_reasoning')
            message['reasoning_content']=values.pop();restored.append(index)
        return body,restored

    def save(self):
        p = self.output / 'budget-status.json'
        tmp = p.with_suffix('.tmp')
        tmp.write_text(json.dumps({'calls': self.calls, 'tokens': self.tokens, 'reason': self.reason}))
        tmp.replace(p)

    def request(self, body):
        queued = time.time()
        with self.lock:
            started = time.time()
            if self.reason:
                return {'error': {'message': self.reason}}
            try:
                body,restored=self.restore_reasoning(body)
            except ValueError as exc:
                (self.output/'protocol-unmatched-request.json').write_text(json.dumps(body,ensure_ascii=False))
                self.reason=str(exc)
                self.save()
                return {'error': {'message': self.reason}}
            try:
                import tiktoken
                estimated = len(tiktoken.get_encoding('cl100k_base').encode(json.dumps(body.get('messages', []), ensure_ascii=False), disallowed_special=()))
            except Exception:
                self.reason = 'token_estimator_unavailable'
                self.save()
                return {'error': {'message': self.reason}}
            if self.calls >= 60 or self.tokens + estimated + 4096 > 1500000:
                self.reason = 'model_call_budget' if self.calls >= 60 else 'token_reservation_budget'
                self.save()
                return {'error': {'message': self.reason}}
            self.calls += 1
            request = dict(body, model=self.provider['models'][0]['id'], stream=False, max_tokens=4096, temperature=0)
            for key in ('max_completion_tokens', 'stream_options', 'reasoning_effort'):
                request.pop(key, None)
            record = {'started': started, 'queue_seconds': started-queued, 'request': request, 'estimated_input_tokens': estimated, 'restored_reasoning_message_indices': restored}
            try:
                req = urllib.request.Request(self.provider['baseUrl'].rstrip('/')+'/chat/completions',
                    data=json.dumps(request).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+self.provider['apiKey']})
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=90) as res:
                    response = json.load(res)
                record['response'] = response
                for choice in response.get('choices',[]):
                    message=choice.get('message',{})
                    if message.get('reasoning_content') is not None:
                        for call in message.get('tool_calls') or []:
                            self.reasoning_cache[self.call_key(call)]=message['reasoning_content']
                usage = response.get('usage') or {}
                actual = usage.get('total_tokens')
                if actual is None and usage.get('prompt_tokens') is not None and usage.get('completion_tokens') is not None:
                    actual = usage['prompt_tokens'] + usage['completion_tokens']
                if actual is None:
                    self.reason = 'usage_missing'
                else:
                    self.tokens += actual
                    if self.tokens >= 1500000:
                        self.reason = 'actual_token_budget'
                if self.calls >= 60 and not self.reason:
                    self.reason = 'model_call_budget'
            except Exception as exc:
                response = {'error': {'message': type(exc).__name__}}
                record['error'] = type(exc).__name__
                if isinstance(exc, urllib.error.HTTPError):
                    record['http_status'] = exc.code
                    record['http_body'] = exc.read(8192).decode(errors='replace')
                self.reason = 'upstream_error'
            record['seconds'] = time.time()-started
            with (self.output / 'model.jsonl').open('a') as f:
                f.write(json.dumps(record, ensure_ascii=False)+'\n')
            self.save()
            return response


class ResourceRelay(ThreadingHTTPServer):
    def __init__(self, provider, trace, path, **kwargs):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 < n < 4000000:
                    self.send_error(413)
                    return
                response = self.server.budget.request(json.loads(self.rfile.read(n)))
                data = json.dumps(response).encode()
                self.send_response(502 if 'error' in response else 200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        super().__init__(('127.0.0.1', 0), Handler)
        self.budget = Budget(provider, Path(path).parent)
