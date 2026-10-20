import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('claude-feishu Python entry, installer and resumed-session isolation', {timeout:60000}, () => {
  const result=spawnSync('/usr/bin/python3',['test/claude_entry_test.py','-v'],{encoding:'utf8',timeout:55000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});

test('selective settings merge and restriction preservation', () => {
  const result=spawnSync('/usr/bin/python3',['test/claude_settings_test.py','-v'],{encoding:'utf8',timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
