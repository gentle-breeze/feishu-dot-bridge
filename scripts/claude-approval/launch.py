#!/usr/bin/env python3
"""Launch a fresh interactive session through the existing authorized wrapper."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import uuid
from hook import call

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--state-dir', required=True)
p.add_argument('--plan', action='store_true')
p.add_argument('--offer-session-bypass', action='store_true', help='Start in plan mode; offer explicit remote plan approval + session bypass')
p.add_argument('--prompt', default='')
a = p.parse_args()
sock = str(Path(a.state_dir).resolve() / 'approval.sock')
wrapper = shutil.which('claude-gptcc')
if not wrapper:
    p.error('Existing claude-gptcc wrapper is required; no setup/login is performed')
session = str(uuid.uuid4())
call(sock, '/register', {'session': session, 'bypass': a.offer_session_bypass})
child = None
try:
    with tempfile.TemporaryDirectory(prefix='claude-approval-') as temp:
        hook = Path(__file__).with_name('hook.py').resolve()
        settings = {'hooks': {event: [{'matcher': '*', 'hooks': [{'type': 'command', 'command': '/usr/bin/python3 ' + shlex.quote(str(hook)), 'timeout': 260}]}] for event in ('PreToolUse', 'PermissionRequest')}}
        config = Path(temp) / 'settings.json'
        config.write_text(json.dumps(settings))
        config.chmod(0o600)
        args = [wrapper, '--setting-sources', '', '--session-id', session, '--permission-mode', 'plan' if a.plan or a.offer_session_bypass else 'manual', '--settings', str(config)]
        if a.offer_session_bypass:
            args.append('--allow-dangerously-skip-permissions')
        if a.prompt:
            args += ['--', a.prompt]
        env = dict(os.environ, CLAUDE_APPROVAL_SOCKET=sock, CLAUDE_APPROVAL_SESSION=session)
        print('Remote approval session: ' + session, flush=True)
        child = subprocess.Popen(args, env=env)
        def stop(signum, frame):
            if child.poll() is None:
                child.terminate()
        signal.signal(signal.SIGTERM, stop)
        while child.poll() is None:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    call(sock, '/heartbeat', {'session': session})
                except Exception:
                    print('Approval connection lost; ending this CLI session.', flush=True)
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                    break
        code = child.returncode
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    try:
        call(sock, '/cancel', {'session': session})
    except Exception:
        pass
raise SystemExit(code)
