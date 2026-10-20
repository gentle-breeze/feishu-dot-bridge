"""Synthetic fixtures only. Never execute HUD or Claude."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/claude-approval'))
from selective_settings import build_settings, reviewed_hud, sources

APPROVAL = {event: [{'matcher': '*', 'hooks': [{'type': 'command', 'command': 'SYNTHETIC_APPROVAL', 'timeout': 260}]}]
            for event in ('SessionStart', 'PreToolUse', 'PermissionRequest')}

class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.home, self.cwd = self.root/'home', self.root/'repo'
        self.home.mkdir(); self.cwd.mkdir()
        self.env = patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': ''})
        self.env.start()
    def tearDown(self):
        self.env.stop(); self.temp.cleanup()
    def write(self, root, data, name='settings.json'):
        p=root/'.claude'/name; p.parent.mkdir(exist_ok=True); p.write_text(json.dumps(data)); return p
    def build(self):
        return build_settings(APPROVAL, self.home, self.cwd)
    def test_preferences_precedence_and_no_other_settings(self):
        paths=[self.write(self.home, {'language':'zh','theme':'dark','env':{'CLAUDE_APPROVAL_SOCKET':'evil'},'model':'other','enabledPlugins':{'evil':True},'mcpServers':{'evil':{}},'skipDangerousModePermissionPrompt':True}),
               self.write(self.cwd, {'language':'en','theme':'light','statusLine':{'type':'command','command':'evil'}}),
               self.write(self.cwd, {'language':'ja'}, 'settings.local.json')]
        original=[p.read_bytes() for p in paths]
        out,manifest=self.build()
        self.assertEqual(out['language'],'ja');self.assertEqual(out['theme'],'light')
        self.assertFalse(out['skipDangerousModePermissionPrompt'])
        for key in ['env','model','enabledPlugins','mcpServers','statusLine']:self.assertNotIn(key,out)
        self.assertEqual([x['scope'] for x in manifest['sources']],['user','project','local'])
        self.assertEqual(original,[p.read_bytes() for p in paths])
        self.assertNotIn('evil',json.dumps(manifest))
    def test_restrictions_accumulate_and_exceptions_stay_out(self):
        self.write(self.home, {'permissions':{'deny':['Read(./secret)'],'ask':['Bash'],'allow':['Write'],'defaultMode':'bypassPermissions','disableBypassPermissionsMode':'disable'},
            'sandbox':{'enabled':True,'autoAllowBashIfSandboxed':True,'allowUnsandboxedCommands':False,'excludedCommands':['*'],
                       'filesystem':{'denyRead':['private'],'allowRead':['/']},'network':{'deniedDomains':['bad.example'],'allowedDomains':['*'],'allowLocalBinding':True}}})
        self.write(self.cwd, {'permissions':{'deny':['Read(./secret)','Write'],'ask':['Edit'],'allow':['*']},
            'sandbox':{'enabled':False,'filesystem':{'denyWrite':['build']},'network':{'deniedDomains':['other.example'],'allowAllUnixSockets':False}}})
        out,_=self.build()
        self.assertEqual(out['permissions'],{'deny':['Read(./secret)','Write'],'ask':['Bash','Edit'],'disableBypassPermissionsMode':'disable'})
        sandbox=out['sandbox'];self.assertTrue(sandbox['enabled']);self.assertFalse(sandbox['autoAllowBashIfSandboxed']);self.assertFalse(sandbox['allowUnsandboxedCommands'])
        self.assertEqual(sandbox['filesystem'],{'denyRead':[str(self.home/'.claude/private')],'denyWrite':[str(self.cwd/'build')]})
        self.assertEqual(sandbox['network'],{'deniedDomains':['bad.example','other.example'],'allowAllUnixSockets':False})
        self.assertNotIn('excludedCommands',sandbox)
    def test_reviewed_hud_only_deduplicated_with_approval_preserved(self):
        command='/opt/homebrew/bin/node '+str(self.home/'Documents/claude-hud/dist/activity-hook.js')
        status='/opt/homebrew/bin/node '+str(self.home/'Documents/claude-hud/dist/index.js')
        observer={'type':'command','command':command,'timeout':2}
        self.write(self.home, {'statusLine':{'type':'command','command':status,'padding':1},'hooks':{
            'PreToolUse':[{'hooks':[observer,observer,{'type':'command','command':'echo allow'}]},{'matcher':'*','hooks':[observer]}],
            'PermissionRequest':[{'hooks':[observer]}]}})
        self.write(self.cwd, {'hooks':{'PreToolUse':[{'hooks':[observer]}]},'statusLine':{'type':'command','command':'evil'}})
        with patch('selective_settings.reviewed_hud',side_effect=lambda cmd,file,home: cmd==('/opt/homebrew/bin/node '+str(home/'Documents/claude-hud/dist'/file))):
            out,_=self.build()
        self.assertEqual(out['statusLine']['command'],status)
        self.assertEqual(len(out['hooks']['PreToolUse']),2)
        self.assertEqual(len(out['hooks']['PermissionRequest']),2)
        self.assertEqual(out['hooks']['PreToolUse'][-1],APPROVAL['PreToolUse'][0])
        self.assertNotIn('echo allow',json.dumps(out))
    def test_unreviewed_commands_and_tampering_never_admitted(self):
        for cmd in [None,'echo hello','/opt/homebrew/bin/node /tmp/hud.js','/opt/homebrew/bin/node '+str(self.home/'Documents/claude-hud/dist/index.js')+'; echo allow']:
            self.assertFalse(reviewed_hud(cmd,'index.js',self.home))
        script=self.home/'Documents/claude-hud/dist/index.js';script.parent.mkdir(parents=True);script.write_text('arbitrary code')
        command='/opt/homebrew/bin/node '+str(script)
        self.assertFalse(reviewed_hud(command,'index.js',self.home))
        self.write(self.home,{'statusLine':{'type':'command','command':command}})
        with self.assertRaises(ValueError):self.build()
    def test_invalid_or_unknown_restrictions_fail_closed(self):
        for data in [{'permissions':{'deny':'Read(*)'}},{'permissions':{'futureRestriction':True}},
                     {'sandbox':{'futureRestriction':True}},{'sandbox':{'filesystem':{'denyRead':42}}},
                     {'disableAllHooks':True},{'allowManagedHooksOnly':True}]:
            with self.subTest(data=data):
                self.write(self.home,data)
                with self.assertRaises(ValueError):self.build()
        p=self.write(self.home,{})
        p.write_text('{bad secret')
        with self.assertRaisesRegex(ValueError,'unreadable_or_invalid_json'):self.build()
    def test_primary_worktree_local_source(self):
        primary=self.root/'primary';(primary/'.git/worktrees/w').mkdir(parents=True)
        (primary/'.git/worktrees/w/commondir').write_text('../..')
        (self.cwd/'.git').write_text('gitdir: '+str(primary/'.git/worktrees/w'))
        self.write(self.cwd,{'language':'local'},'settings.local.json')
        self.write(primary,{'language':'root','permissions':{'deny':['Write']}},'settings.local.json')
        out,m=self.build();self.assertEqual(out['language'],'root');self.assertEqual(out['permissions']['deny'],['Write'])
        self.assertEqual(m['sources'][-1]['scope'],'root-local')
    def test_broken_source_symlink_does_not_silently_drop_restrictions(self):
        p=self.write(self.home,{})
        p.unlink();p.symlink_to(self.root/'missing')
        with self.assertRaises(ValueError):self.build()
    def test_custom_config_home_rejected_not_ignored(self):
        with patch.dict(os.environ,{'CLAUDE_CONFIG_DIR':str(self.root/'different')}):
            with self.assertRaises(ValueError):self.build()

if __name__=='__main__':unittest.main()
