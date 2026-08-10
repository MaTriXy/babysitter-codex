'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('npm pack includes the full plugin bundle', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.strictEqual(result.status, 0, `npm pack failed: ${result.stderr}`);
  // npm may prepend log noise; the JSON payload starts at the first '['.
  const stdout = result.stdout.slice(result.stdout.indexOf('['));
  const [pack] = JSON.parse(stdout);
  const files = new Set(pack.files.map((f) => f.path));

  const required = [
    'package.json',
    'hooks.json',
    'versions.json',
    '.codex-plugin/plugin.json',
    'bin/cli.js',
    'bin/install.js',
    'bin/install-shared.js',
    'bin/uninstall.js',
    'hooks/babysitter-hook-lib.sh',
    'hooks/babysitter-proxied-session-start.sh',
    'hooks/babysitter-proxied-session-end.sh',
    'hooks/babysitter-proxied-pre-tool-use.sh',
    'hooks/babysitter-proxied-post-tool-use.sh',
    'hooks/babysitter-proxied-user-prompt-submit.sh',
    'hooks/babysitter-proxied-stop.sh',
  ];
  for (const file of required) {
    assert.ok(files.has(file), `packaged tarball missing ${file}`);
  }
});

test('cli entrypoint prints usage', () => {
  const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'cli.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.stderr.includes('babysitter-codex install'), 'usage text missing');
});

console.log(`\n${passed} packaged-install checks passed`);
