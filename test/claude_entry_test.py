import contextlib
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts/claude-approval'
KEYS = ['ANTHROPIC_DEFAULT_'+x+'_MODEL' for x in ('OPUS','SONNET','HAIKU','FABLE')] + ['CLAUDE_CODE_SUBAGENT_MODEL']

class EntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cfe-', dir='/tmp')
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home space'
        self.home.mkdir()
        self.cwd = self.root/'caller space'
        self.cwd.mkdir()
        self.bin = self.root/'bin'
        self.bin.mkdir()
        (self.bin/'python3').symlink_to(sys.executable)
        self.env = {'HOME':str(self.home), 'PATH':str(self.bin), 'PYTHONDONTWRITEBYTECODE':'1'}
        self.models = dict(zip(KEYS, ['provider-opus','provider-sonnet','provider-haiku','provider-fable','provider-agent']))
        self.config({'env':dict(self.models, SECRET_TEST='do-not-copy'), 'model':'do-not-copy', 'hooks':{'SECRET_TEST':'do-not-copy'}})
        self.record = self.root/'record.json'
        self.env['RECORD'] = str(self.record)
    def tearDown(self):
        self.temp.cleanup()
    def config(self, data):
        p = self.home/'.claude/settings.json'
        p.parent.mkdir(exist_ok=True)
        p.write_text(json.dumps(data))
    def run_cmd(self, args, env=None):
        return subprocess.run([sys.executable,*map(str,args)],cwd=self.cwd,env=env or self.env,text=True,capture_output=True,timeout=20)
    def fake_launch(self):
        dest=self.root/'repository space'
        shutil.copytree(SCRIPTS,dest)
        (dest/'launch.py').write_text('import os,sys,json\nfrom pathlib import Path\nPath(os.environ["RECORD"]).write_text(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd(),"env":dict(os.environ)}))\nsys.exit(23)\n')
        return dest/'claude-feishu'
    def test_only_five_keys_env_priority_cwd_args_exit(self):
        entry=self.fake_launch()
        original=(self.home/'.claude/settings.json').read_bytes()
        self.env[KEYS[0]]='existing-opus'
        self.env['ANTHROPIC_MODEL']='existing-opus'
        self.env['SECRET_TEST']='inherited-not-from-settings'
        r=self.run_cmd([entry,'--plan','--prompt','hello spaces ; $(no-exec)'])
        self.assertEqual(r.returncode,23,r.stderr)
        data=json.loads(self.record.read_text())
        self.assertEqual(data['cwd'],str(self.cwd))
        self.assertEqual(data['env'][KEYS[0]],'existing-opus')
        self.assertEqual(data['env']['SECRET_TEST'],'inherited-not-from-settings')
        self.assertNotIn('do-not-copy',json.dumps(data))
        self.assertEqual(data['args'],['--state-dir',str(self.home/'.claude-feishu-approval'),'--plan','--prompt','hello spaces ; $(no-exec)','--model','existing-opus'])
        self.assertEqual(original,(self.home/'.claude/settings.json').read_bytes())
    def test_missing_malformed_and_env_only(self):
        entry=self.fake_launch()
        config=self.home/'.claude/settings.json'
        for content in ['{secret broken', '[]', '{"env":[]}', '{"env":{}}']:
            with self.subTest(content=content):
                config.write_text(content)
                r=self.run_cmd([entry])
                self.assertEqual(r.returncode,2)
                self.assertNotIn('secret broken',r.stderr)
                self.assertFalse(self.record.exists())
        config.unlink()
        self.assertEqual(self.run_cmd([entry]).returncode,2)
        self.env.update(self.models)
        self.assertEqual(self.run_cmd([entry]).returncode,23)
    def test_effective_models_and_empty_env_not_overwritten(self):
        entry=self.fake_launch()
        for model in ['opus','sonnet','haiku','fable',*self.models.values()]:
            self.assertEqual(self.run_cmd([entry,'--model='+model]).returncode,23)
        for model in ['default','best','claude-opus-4-6','unmapped']:
            self.assertEqual(self.run_cmd([entry,'--model',model]).returncode,2)
        self.env[KEYS[0]]=''
        self.assertEqual(self.run_cmd([entry,'--model','sonnet']).returncode,2)
        self.env[KEYS[0]]='env-opus'
        self.assertEqual(self.run_cmd([entry,'--model','env-opus']).returncode,23)
        self.assertEqual(self.run_cmd([entry,'--model','provider-opus']).returncode,2)
    def test_required_keys_each_missing_and_invalid(self):
        entry=self.fake_launch()
        for key in KEYS:
            for value in [None, '', 1, [], 'has space']:
                values=dict(self.models)
                values[key]=value
                self.config({'env':values})
                r=self.run_cmd([entry])
                self.assertEqual(r.returncode,2)
                self.assertIn(key,r.stderr)
    def test_direct_openai_ids_and_selection_priority(self):
        entry=self.fake_launch()
        for model in ['gpt-6-astra','gpt-future-release','chatgpt-future-latest','o3','o42-future']:
            with self.subTest(model=model):
                r=self.run_cmd([entry,'--model='+model])
                self.assertEqual(r.returncode,23,r.stderr)
                args=json.loads(self.record.read_text())['args']
                self.assertIn('--model='+model,args)
        self.env['ANTHROPIC_DEFAULT_MODEL']='gpt-future-default'
        self.assertEqual(self.run_cmd([entry]).returncode,23)
        self.assertEqual(json.loads(self.record.read_text())['args'][-1],'gpt-future-default')
        self.env['ANTHROPIC_MODEL']='gpt-6-astra'
        self.assertEqual(self.run_cmd([entry]).returncode,23)
        self.assertEqual(json.loads(self.record.read_text())['args'][-1],'gpt-6-astra')
        self.assertEqual(self.run_cmd([entry,'--model','chatgpt-explicit']).returncode,23)
        data=json.loads(self.record.read_text())
        self.assertEqual(data['args'][-1],'chatgpt-explicit')
        self.assertEqual(data['env']['ANTHROPIC_MODEL'],'gpt-6-astra')
        for model in ['gpt-','chatgpt-','o','gpt-x --permission-mode=bypassPermissions','gpt-x\n--settings=x','gpt-$(command)','--settings=x']:
            self.assertEqual(self.run_cmd([entry,'--model='+model]).returncode,2)
        for args in [['--permission-mode=bypassPermissions'],['--settings=x'],['--setting-sour=user'],['--mcp-config=x'],['-pc'],['--print'],['--','--settings=x']]:
            self.assertEqual(self.run_cmd([entry,'--model=gpt-6-astra',*args]).returncode,2)
        # Direct IDs never bypass the existing five-key requirements.
        self.env[KEYS[0]]=''
        self.assertEqual(self.run_cmd([entry,'--model=gpt-6-astra']).returncode,2)
    def test_missing_launcher(self):
        entry=self.fake_launch()
        entry.with_name('launch.py').unlink()
        r=self.run_cmd([entry])
        self.assertEqual(r.returncode,2)
        self.assertIn('launch.py is missing',r.stderr)
    def test_closed_cli_grammar_both_entry_and_launcher(self):
        entry=self.fake_launch()
        bad=[['--permission-mode','bypassPermissions'],['--permission-mode=bypassPermissions'],['--permission-m=bypassPermissions'],['--settings=x'],['--setting-sources=user'],['--setting-sour=user'],['--mcp-config=x'],['-p'],['-phello'],['-pc'],['--print=x'],['--pri'],['--','--settings=x'],['--dangerously-skip-permissions'],['--offer-session-bypass=true'],['--offer-session-byp'],['--state-dir=/tmp/other'],['--mod=opus'],['--plan=true'],['--continue=true'],['--session-id=not-uuid'],['--resume=--settings=x']]
        for args in bad:
            with self.subTest(args=args):
                self.assertEqual(self.run_cmd([entry,*args]).returncode,2)
                if args[0] not in ['--offer-session-bypass','--state-dir=/tmp/other']:
                    self.assertEqual(self.run_cmd([SCRIPTS/'launch.py','--state-dir',self.root/'state',*args]).returncode,2)
        self.assertFalse(self.record.exists())
        # Option-like text inside a prompt is data and remains behind CLI --.
        self.assertEqual(self.run_cmd([entry,'--prompt=--settings=x']).returncode,23)
    def test_install_idempotent_and_conflicts(self):
        for _ in range(2):
            r=self.run_cmd([SCRIPTS/'install.py'])
            self.assertEqual(r.returncode,0,r.stderr)
        target=self.home/'.local/bin/claude-feishu'
        self.assertEqual(target.resolve(),SCRIPTS/'claude-feishu')
        installed_env=dict(self.env, PATH=str(target.parent)+':'+self.env['PATH'])
        installed=subprocess.run(['claude-feishu','--help'],env=installed_env,cwd=self.cwd,text=True,capture_output=True,timeout=5)
        self.assertEqual(installed.returncode,0,installed.stderr)
        self.assertIn('--resume',installed.stdout)
        self.assertFalse((self.home/'.zshrc').exists())
        target.unlink();target.write_text('existing')
        self.assertEqual(self.run_cmd([SCRIPTS/'install.py']).returncode,2)
        self.assertEqual(target.read_text(),'existing')
        target.unlink();target.symlink_to('/missing/other')
        self.assertEqual(self.run_cmd([SCRIPTS/'install.py']).returncode,2)
        target.unlink()
        other=self.bin/'claude-feishu';other.write_text('#!/bin/sh\nexit 0\n');other.chmod(0o700)
        self.assertEqual(self.run_cmd([SCRIPTS/'install.py']).returncode,2)
        self.assertFalse(target.exists())
    @contextlib.contextmanager
    def broker(self):
        state=self.home/'.claude-feishu-approval';state.mkdir()
        messages=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(inner):
                data=json.loads(inner.rfile.read(int(inner.headers['content-length'])))
                messages.append((inner.path,data))
                response={'guard':True} if inner.path=='/hook' else {'ok':True}
                inner.send_response(200);inner.end_headers();inner.wfile.write(json.dumps(response).encode())
        server=socketserver.UnixStreamServer(str(state/'approval.sock'),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try: yield messages
        finally: server.shutdown();server.server_close();thread.join()
    def test_launcher_recovery_binds_identity_fresh_lease_and_exit(self):
        wrapper=self.bin/'claude-gptcc'
        wrapper.write_text('#!'+sys.executable+'\n'+'''import os,sys,json,subprocess,shlex
from pathlib import Path
args=sys.argv[1:]
settings=json.loads(Path(args[args.index('--settings')+1]).read_text())
cli=args[args.index('--session-id')+1] if '--session-id' in args else os.environ['FAKE_CLI_SESSION']
result={'args':args,'cwd':os.getcwd(),'lease':os.environ['CLAUDE_APPROVAL_SESSION'],'identity':os.environ['CLAUDE_APPROVAL_IDENTITY_FILE'],'hooks':list(settings['hooks'])}
def hook(event,sid):
 cmd=settings['hooks'][event][0]['hooks'][0]['command']
 h={'session_id':sid,'hook_event_name':event,'tool_name':'Read','tool_input':{}}
 p=subprocess.run(shlex.split(cmd),input=json.dumps(h),text=True,capture_output=True)
 return json.loads(p.stdout)
result['before']=hook('PreToolUse',cli)
result['start']=hook('SessionStart',cli)
result['after']=hook('PreToolUse',cli)
result['wrong']=hook('PreToolUse','00000000-0000-4000-8000-000000000001')
result['rebind']=hook('SessionStart','00000000-0000-4000-8000-000000000001')
Path(os.environ['RECORD']).write_text(json.dumps(result))
sys.exit(17)
''');wrapper.chmod(0o700)
        old=str(uuid.uuid4());self.env['FAKE_CLI_SESSION']=old
        leases=[]
        with self.broker() as messages:
            for options in [[],['--plan'],['--offer-session-bypass'],['--resume',old],['--resume','name with spaces'],['--resume'],['--continue'],['--session-id',old]]:
                with self.subTest(options=options):
                    r=self.run_cmd([SCRIPTS/'claude-feishu',*options,'--model','opus','--prompt=--settings=x'])
                    self.assertEqual(r.returncode,17,r.stderr)
                    data=json.loads(self.record.read_text());args=data['args']
                    leases.append(data['lease'])
                    self.assertEqual(data['cwd'],str(self.cwd))
                    self.assertEqual(args[args.index('--permission-mode')+1],'plan' if '--plan' in options or '--offer-session-bypass' in options else 'manual')
                    self.assertEqual('--allow-dangerously-skip-permissions' in args,'--offer-session-bypass' in options)
                    self.assertNotIn('--dangerously-skip-permissions',args)
                    self.assertEqual(args[-2:],['--','--settings=x'])
                    self.assertEqual(args[args.index('--setting-sources')+1],'')
                    self.assertEqual(args[args.index('--model')+1],'opus')
                    self.assertEqual(data['start'],{})
                    self.assertEqual(data['after'],{})
                    self.assertEqual(data['wrong']['hookSpecificOutput']['permissionDecision'],'deny')
                    self.assertFalse(data['rebind']['continue'])
                    self.assertFalse(Path(data['identity']).exists())
                    if '--resume' in options or '--continue' in options:
                        self.assertNotIn('--session-id',args)
                        self.assertEqual(data['before']['hookSpecificOutput']['permissionDecision'],'deny')
                    self.assertTrue(all(x['session_id']==data['lease'] for route,x in messages if route=='/hook'))
                    self.assertEqual(messages[-1],('/cancel',{'session':data['lease']}))
                    messages.clear()
            self.assertEqual(len(set(leases)),len(leases))
            self.assertNotIn(old,leases)
    def test_recovery_conflicts(self):
        for args in [['--offer-session-bypass','--resume'],['--offer-session-bypass','--continue'],['--resume','--continue'],['--session-id',str(uuid.uuid4()),'--resume'],['--session-id',str(uuid.uuid4()),'--continue']]:
            self.assertEqual(self.run_cmd([SCRIPTS/'claude-feishu',*args]).returncode,2)

    def test_missing_broker_never_starts_wrapper_and_missing_identity_denies(self):
        wrapper=self.bin/'claude-gptcc'
        wrapper.write_text('#!'+sys.executable+'\nimport os\nfrom pathlib import Path\nPath(os.environ["RECORD"]).write_text("started")\n')
        wrapper.chmod(0o700)
        result=self.run_cmd([SCRIPTS/'claude-feishu'])
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Approval service unavailable',result.stderr)
        self.assertFalse(self.record.exists())
        env=dict(self.env,CLAUDE_APPROVAL_SESSION=str(uuid.uuid4()),CLAUDE_APPROVAL_IDENTITY_FILE=str(self.root/'missing.json'))
        result=subprocess.run([sys.executable,str(SCRIPTS/'hook.py')],input=json.dumps({'session_id':str(uuid.uuid4()),'hook_event_name':'PermissionRequest'}),env=env,text=True,capture_output=True,timeout=5)
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['decision']['behavior'],'deny')

if __name__ == '__main__': unittest.main()
