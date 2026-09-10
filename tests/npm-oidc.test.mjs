import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/verify-npm-oidc.mjs', import.meta.url).href;
const secrets = ['fake-runner-token', 'fake-identity-token', 'fake-registry-token'];

function runProbe(mode) {
  const env = { ...process.env };
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (mode !== 'missing') {
    env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.example.test/token?job=example';
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = secrets[0];
  }
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(options.redirect, 'error');
      if (calls === 1) {
        assert.equal(new URL(url).searchParams.get('audience'), 'npm:registry.npmjs.org');
        assert.equal(options.headers.Authorization, 'Bearer ${secrets[0]}');
        return { ok: true, json: async () => {
          if (${JSON.stringify(mode)} === 'malformed') throw new Error('${secrets[1]}');
          return { value: '${secrets[1]}' };
        } };
      }
      assert.equal(calls, 2);
      assert.equal(String(url), 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40linsoai%2Fbrowser-relay');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ${secrets[1]}');
      return { status: ${mode === 'denied' ? 403 : 201}, json: async () => ({
        token_type: 'oidc', token: '${secrets[2]}', expires: '2099-01-01T00:00:00Z'
      }) };
    };
    await import(${JSON.stringify(script)});
    assert.equal(calls, ${mode === 'missing' ? 0 : mode === 'malformed' ? 1 : 2});
  `], { env, encoding: 'utf8' });
}

test('OIDC probe verifies the package grant without publishing or exposing credentials', () => {
  const result = runProbe('success');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OIDC authentication verified for @linsoai\/browser-relay/);
  for (const value of secrets) assert.ok(!(result.stdout + result.stderr).includes(value));
});

test('OIDC probe rejects missing credentials and npm permission failures', () => {
  for (const mode of ['missing', 'denied']) {
    const result = runProbe(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, mode === 'missing' ? /id-token: write/ : /HTTP 403/);
    for (const value of secrets) assert.ok(!(result.stdout + result.stderr).includes(value));
  }
});

test('OIDC probe does not echo credential-bearing provider parse errors', () => {
  const result = runProbe('malformed');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requesting or reading provider credentials/);
  for (const value of secrets) assert.ok(!(result.stdout + result.stderr).includes(value));
});
