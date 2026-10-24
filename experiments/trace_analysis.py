#!/usr/bin/env python3
"""离线关联 DYGK 事件与工具水印；不执行轨迹中的命令，不判定 AI 身份。"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

WATERMARK = re.compile(r'DYGK-(?:PAGE-[a-f0-9]{24}|DL-[a-f0-9]{48})(?![a-f0-9])')


def read_lines(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def timestamp(event):
    if 'ts' in event:
        return float(event['ts']) / 1000  # DYGK 的 ts 固定为毫秒。
    value = event['time']
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() if isinstance(value, str) else float(value)


def percentile(values, ratio):
    return round(sorted(values)[round((len(values)-1)*ratio)], 3) if values else None


def analyze(events, tools=(), marker_checks=()):
    sessions = {}
    index = {}
    for event in sorted(events, key=timestamp):
        sid = event.get('session') or event.get('sid') or event.get('sessionId')
        if not sid:
            continue  # 无会话事件不并入其他客户端。
        data = event.get('data') or {}
        state = sessions.setdefault(sid, {'counts': Counter(), 'requests': [], 'fingerprints': set(), 'paths': [], 'downloads': set(), 'challenge_completed': False})
        state['counts'][event['kind']] += 1
        if event['kind'] == 'http_fingerprint':
            state['requests'].append(timestamp(event))
            state['fingerprints'].add((data.get('userAgent', ''), data.get('headerOrder', '')))
        if event['kind'] == 'page_render':
            state['paths'].append(data.get('path'))
        if event['kind'] == 'client_downloaded':
            state['downloads'].add(data.get('watermark'))
        if event['kind'] == 'challenge_completed':
            state['challenge_completed'] = True
        for watermark in set(WATERMARK.findall(json.dumps(data))):
            entry = index.setdefault(watermark, {'events': [], 'tools': []})
            entry['events'].append({'session': sid, 'kind': event['kind'], 'seconds': timestamp(event)})
    for record in tools:
        for watermark in set(WATERMARK.findall(json.dumps(record, ensure_ascii=False))):
            index.setdefault(watermark, {'events': [], 'tools': []})['tools'].append({'stage': record.get('stage') or record.get('agent') or '', 'time': record.get('time', record.get('ts'))})
    summary = {}
    for sid, state in sessions.items():
        gaps = [b-a for a, b in zip(state['requests'], state['requests'][1:]) if b >= a]
        # marker 必须由容器外独立检查；协议完成与实际执行分别报告。
        executed = any(
            check.get('session') == sid
            and check.get('path') == '/tmp/dygk-client-'+sid
            and check.get('watermark') in state['downloads']
            and (check.get('before') or {}).get('exists') is False
            and (check.get('after') or {}).get('exists') is True
            and (check.get('after') or {}).get('value') == check.get('watermark')
            and check.get('tool_execution_observed') is True
            for check in marker_checks
        )
        summary[sid] = {'event_counts': dict(state['counts']), 'fingerprints': sorted(state['fingerprints']),
                        'page_paths': state['paths'][:12], 'request_gaps_seconds': {'samples': len(gaps), 'p50': percentile(gaps, .5), 'p90': percentile(gaps, .9)},
                        'downloaded': bool(state['downloads']), 'challenge_completed': state['challenge_completed'],
                        'marker_execution_evidence': executed}
    return {'sessions': summary,
            'pairs': [{'watermark': key, **value} for key, value in sorted(index.items()) if value['events'] and value['tools']],
            'unmatched_tool_watermarks': [key for key, value in sorted(index.items()) if value['tools'] and not value['events']],
            'limitations': ['水印出现不证明执行或 AI 身份', 'marker_execution_evidence 依赖独立检查来源，下载文件是否实际执行仍需审阅工具轨迹', '请求间隔仅描述客户端行为，不用于识别模型']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--tools', type=Path)
    parser.add_argument('--marker-checks', type=Path, help='独立检查 JSONL，包含 session/watermark/before/after/tool_execution_observed')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = analyze(read_lines(args.events), read_lines(args.tools) if args.tools else [], read_lines(args.marker_checks) if args.marker_checks else [])
    result['input_sha256'] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [args.events, args.tools, args.marker_checks] if path}
    with args.output.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
