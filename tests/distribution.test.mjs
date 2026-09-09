import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf-8'));

test('development publication defaults to next and requires an explicit non-latest tag before syncing', () => {
  const pkg=readJson('package.json');
  assert.equal(pkg.publishConfig.tag,pkg.version.includes('-')?'next':'latest');
  assert.match(pkg.scripts.prepublishOnly,/^node scripts\/check-publish.mjs && /);
  for (const tag of ['next','latest']) {
    const result=spawnSync(process.execPath,['scripts/check-publish.mjs'],{cwd:root,env:{...process.env,npm_config_tag:tag},encoding:'utf8'});
    assert.equal(result.status,pkg.version.includes('-') && tag==='latest'?1:0,result.stderr);
  }
});

test('real npm lifecycle refuses default and explicit latest even when npm omits the tag environment variable',t=>{
  const dir=mkdtempSync(join(tmpdir(),'browser-relay-publish-guard-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'scripts'));
  copyFileSync(join(root,'scripts/check-publish.mjs'),join(dir,'scripts/check-publish.mjs'));
  const pkg={...readJson('package.json'),version:'1.5.1-dev.test',publishConfig:{access:'public',tag:'next'}};
  writeFileSync(join(dir,'package.json'),JSON.stringify({...pkg,scripts:{prepublishOnly:'node scripts/check-publish.mjs'}}));
  const npm=process.env.npm_execpath;
  for(const tag of [undefined,'latest','next']) {
    const env={...process.env};delete env.npm_config_tag;
    const args=['run','prepublishOnly',...(tag?[`--tag=${tag}`]:[])];
    const result=npm?spawnSync(process.execPath,[npm,...args],{cwd:dir,env,encoding:'utf8'}):spawnSync(process.platform==='win32'?'npm.cmd':'npm',args,{cwd:dir,env,encoding:'utf8',shell:process.platform==='win32'});
    assert.equal(result.status,pkg.version.includes('-') && tag!=='next'?1:0,result.stderr);
  }
});

test('agent marketplace manifests follow the package version and standard skill path', () => {
  const pkg = readJson('package.json');
  const manifests = [
    'extension/manifest.json',
    'gemini-extension.json',
    '.github/plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ];

  for (const path of manifests) {
    if(path==='extension/manifest.json') {
      assert.equal(readJson(path).version,pkg.version.split('-')[0]);
      assert.equal(readJson(path).version_name,pkg.version);
    } else assert.equal(readJson(path).version, pkg.version, path);
  }
  assert.ok(existsSync(join(root, 'skills/browser-relay/SKILL.md')));
  assert.ok(pkg.files.includes('skills/'));
});

test('npm can select the English root README without dropping Chinese docs', () => {
  const rootReadmes = readdirSync(root)
    .filter((name) => /^readme(?:\.|$)/i.test(name))
    .sort();

  assert.deepEqual(rootReadmes, ['README.md']);
  assert.ok(existsSync(join(root, 'docs/README.zh-CN.md')));
});
