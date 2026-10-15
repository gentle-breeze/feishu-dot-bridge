import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
function checkTemplate(text: string) {
  assert.match(text, /^FEISHU_MEDIA_INPUT=images-v1$/m);
  assert.match(text, /^FEISHU_IMAGE_OUTPUT=on$/m);
  assert.doesNotMatch(text, /^FEISHU_MACOS_IMAGE_POLICY=/m);
}
test('checked-in image defaults do not opt into weaker macOS policy', () => {
  for (const file of ['.env.example', 'examples/oauth.env.example']) checkTemplate(readFileSync(file, 'utf8'));
});
test('fresh personal template enables images without adopting existing configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-image-init-'));
  try {
    const run = () => spawnSync(process.execPath, [resolve('dist/scripts/init-personal.js')], { cwd: dir, env: {PATH:process.env.PATH}, encoding:'utf8' });
    assert.equal(run().status, 0);
    const before = readFileSync(join(dir, '.env'), 'utf8');
    checkTemplate(before);
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), before);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
