#!/usr/bin/env python3
"""Single-shot Claude hook; no SDK, credentials, or global configuration writes."""
import http.client
import json
import os
import socket
import sys
import time

class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout=3):
        super().__init__('localhost', timeout=timeout)
        self.path = path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)

def call(path, route, data):
    c = UnixHTTP(path)
    try:
        c.request('POST', route, json.dumps(data), {'Content-Type': 'application/json'})
        r = c.getresponse()
        raw = r.read(65537)
        if r.status != 200 or len(raw) > 65536:
            raise RuntimeError('broker_rejected')
        return json.loads(raw)
    finally:
        c.close()

def deny(event, reason):
    if event == 'PermissionRequest':
        return {'hookSpecificOutput': {'hookEventName': event, 'decision': {'behavior': 'deny', 'message': reason}}}
    if event == 'PreToolUse':
        return {'hookSpecificOutput': {'hookEventName': event, 'permissionDecision': 'deny', 'permissionDecisionReason': reason}}
    return {'continue': False, 'stopReason': reason}

def main():
    event = None
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError('too_large')
        h = json.loads(raw)
        event = h.get('hook_event_name')
        if event not in ('PreToolUse', 'PermissionRequest'):
            raise ValueError('unsupported_event')
        session = os.environ['CLAUDE_APPROVAL_SESSION']
        if h.get('session_id') != session:
            raise ValueError('session_mismatch')
        path = os.environ['CLAUDE_APPROVAL_SOCKET']
        # Send only fields needed to decide, not transcript paths or environment.
        h = {k: h[k] for k in ('session_id','hook_event_name','tool_name','tool_input','tool_use_id','permission_mode') if k in h}
        response = call(path, '/hook', h)
        if response.get('guard') is True:
            return {}
        deadline = time.monotonic() + 245
        while time.monotonic() < deadline:
            if 'request' in response:
                request = response['request']
            response = call(path, '/poll', {'request': request, 'session': session})
            if response.get('done') is True:
                return response['result']
            time.sleep(.25)
        return deny(event, 'REMOTE_TIMEOUT')
    except Exception:
        return deny(event, 'REMOTE_UNAVAILABLE_OR_INVALID')

if __name__ == '__main__':
    print(json.dumps(main(), ensure_ascii=False))
