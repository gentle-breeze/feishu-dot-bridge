#!/usr/bin/env python3
"""Launch an interactive CLI with a fresh, isolated approval lease."""
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import uuid
import sys
from hook import call
from entry_options import parse

a = parse(sys.argv[1:], launcher=True)
sock = str(Path(a.state_dir).resolve() / 'approval.sock')
wrapper = shutil.which('claude-gptcc')
if not wrapper:
    sys.exit('Existing claude-gptcc wrapper is required; no setup/login is performed')
session = str(uuid.uuid4())
resuming = a.resume is not None or a.continue_session
cli_session = None if resuming else (a.session_id or session)
try:
    call(sock, '/register', {'session': session, 'bypass': a.offer_session_bypass})
except Exception:
    sys.exit('Approval service unavailable; check the configured private state directory. No CLI started.')
child = None
try:
    with tempfile.TemporaryDirectory(prefix='claude-approval-') as temp:
        hook = Path(__file__).with_name('hook.py').resolve()
        identity = Path(temp) / 'cli-session.json'
        identity.write_text(json.dumps({'session': cli_session}))
        identity.chmod(0o600)
        settings = {'hooks': {event: [{'matcher': '*', 'hooks': [{'type': 'command', 'command': shlex.quote(sys.executable) + ' ' + shlex.quote(str(hook)), 'timeout': 260}]}] for event in ('SessionStart', 'PreToolUse', 'PermissionRequest')}}
        config = Path(temp) / 'settings.json'
        config.write_text(json.dumps(settings))
        config.chmod(0o600)
        args = [wrapper, '--setting-sources', '', '--permission-mode', 'plan' if a.plan or a.offer_session_bypass else 'manual', '--settings', str(config)]
        if cli_session:
            args += ['--session-id', cli_session]
        if a.resume is not None:
            args += ['--resume'] + ([a.resume] if a.resume else [])
        if a.continue_session:
            args.append('--continue')
        if a.model is not None:
            args += ['--model', a.model]
        if a.offer_session_bypass:
            args.append('--allow-dangerously-skip-permissions')
        if a.prompt is not None:
            args += ['--', a.prompt]
        env = dict(os.environ, CLAUDE_APPROVAL_SOCKET=sock, CLAUDE_APPROVAL_SESSION=session, CLAUDE_APPROVAL_IDENTITY_FILE=str(identity))
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
