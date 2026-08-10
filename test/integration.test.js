'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const shared = require('../bin/install-shared');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readHooksConfig(codexHome) {
  return JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
}

function handlerCommands(hooksConfig) {
  const commands = [];
  for (const matchers of Object.values(hooksConfig.hooks || {})) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      for (const hook of matcher.hooks || []) {
        commands.push(String(hook.command || ''));
      }
    }
  }
  return commands;
}

// Writes stub adapters-hooks/babysitter binaries; the adapters-hooks stub
// records its argv and stdin so tests can assert the wrapper wiring.
function writeStubBins(binDir, argsFile, stdinFile) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'adapters-hooks'),
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n${stdinFile ? `cat > "${stdinFile}"\n` : 'cat > /dev/null\n'}echo '{}'\n`,
  );
  fs.writeFileSync(path.join(binDir, 'babysitter'), '#!/bin/bash\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'adapters-hooks'), 0o755);
  fs.chmodSync(path.join(binDir, 'babysitter'), 0o755);
}

// Copies the stop wrapper + lib (and marker) into a directory, emulating an
// installed surface.
function writeSurfaceCopy(hooksDir, withMarker = true) {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of [shared.MANAGED_HOOK_LIB_NAME, 'babysitter-proxied-stop.sh']) {
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'hooks', name), path.join(hooksDir, name));
    fs.chmodSync(path.join(hooksDir, name), 0o755);
  }
  if (withMarker) {
    fs.writeFileSync(path.join(hooksDir, shared.MANAGED_SURFACE_MARKER), '{}');
  }
}

function runHook(scriptPath, { cwd, home, binDir, codexHome }) {
  const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` };
  if (codexHome) env.CODEX_HOME = codexHome;
  else delete env.CODEX_HOME;
  return spawnSync('bash', [scriptPath], { cwd, env, input: '{}', encoding: 'utf8' });
}

const EXPECTED_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
];

test('hooks.json references only scripts that exist and are managed', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(
    Object.keys(hooksConfig.hooks).sort(),
    [...EXPECTED_EVENTS].sort(),
    'hooks.json events mismatch',
  );
  for (const command of handlerCommands(hooksConfig)) {
    const match = command.match(/babysitter-proxied-[A-Za-z0-9_-]+\.sh/);
    assert.ok(match, `no managed script referenced in: ${command}`);
    const scriptName = match[0];
    assert.ok(
      fs.existsSync(path.join(PACKAGE_ROOT, 'hooks', scriptName)),
      `missing hooks/${scriptName}`,
    );
    assert.ok(
      shared.MANAGED_HOOK_SCRIPT_NAMES.includes(scriptName),
      `${scriptName} missing from MANAGED_HOOK_SCRIPT_NAMES`,
    );
    assert.ok(
      command.includes('${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}'),
      `command must guard on the plugin-root env Codex sets: ${command}`,
    );
  }
});

test('every managed hook script exists, is executable, and passes bash -n', () => {
  const scripts = [...shared.MANAGED_HOOK_SCRIPT_NAMES, shared.MANAGED_HOOK_LIB_NAME];
  for (const scriptName of scripts) {
    const scriptPath = path.join(PACKAGE_ROOT, 'hooks', scriptName);
    assert.ok(fs.existsSync(scriptPath), `missing ${scriptPath}`);
    if (process.platform !== 'win32') {
      fs.accessSync(scriptPath, fs.constants.X_OK);
      const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `bash -n failed for ${scriptName}: ${result.stderr}`);
    }
  }
});

test('installCodexSurface installs scripts, marker, and absolute commands', () => {
  const codexHome = tmpdir('bsit-codex-home-');
  shared.installCodexSurface(PACKAGE_ROOT, codexHome);

  for (const scriptName of [...shared.MANAGED_HOOK_SCRIPT_NAMES, shared.MANAGED_HOOK_LIB_NAME]) {
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', scriptName)), `missing ${scriptName}`);
  }
  assert.ok(fs.existsSync(path.join(codexHome, 'hooks', shared.MANAGED_SURFACE_MARKER)), 'missing surface marker');
  assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'versions.json')), 'missing versions.json copy');

  const hooksConfig = readHooksConfig(codexHome);
  assert.deepStrictEqual(Object.keys(hooksConfig.hooks).sort(), [...EXPECTED_EVENTS].sort());
  const hookDir = path.join(codexHome, 'hooks').replace(/\\/g, '/');
  for (const command of handlerCommands(hooksConfig)) {
    assert.ok(!command.includes('CLAUDE_PLUGIN_ROOT'), `surface command not rewritten: ${command}`);
    assert.ok(command.startsWith(`bash "${hookDir}/`), `surface command not absolute: ${command}`);
  }
});

test('installCodexSurface is idempotent and preserves user hooks and unknown shapes', () => {
  const codexHome = tmpdir('bsit-codex-home-');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'hooks.json'),
    JSON.stringify({
      $schema: 'https://example.com/hooks.schema.json',
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        Notification: { enabled: true },
      },
    }, null, 2),
  );

  shared.installCodexSurface(PACKAGE_ROOT, codexHome);
  shared.installCodexSurface(PACKAGE_ROOT, codexHome);

  const hooksConfig = readHooksConfig(codexHome);
  const commands = handlerCommands(hooksConfig);
  assert.strictEqual(
    commands.filter((c) => c.includes('babysitter-proxied-pre-tool-use.sh')).length,
    1,
    'managed PreToolUse hook duplicated after reinstall',
  );
  assert.strictEqual(commands.filter((c) => c === 'echo user-hook').length, 1, 'user hook lost');
  assert.deepStrictEqual(hooksConfig.hooks.Notification, { enabled: true }, 'unknown-shaped event mutated');
  assert.strictEqual(hooksConfig.$schema, 'https://example.com/hooks.schema.json', 'top-level key lost');
});

test('removeManagedCodexSurface removes managed hooks and skills, keeps user data and the file', () => {
  const codexHome = tmpdir('bsit-codex-home-');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'hooks.json'),
    JSON.stringify({
      $schema: 'https://example.com/hooks.schema.json',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] },
    }, null, 2),
  );
  // Unrelated user skill sharing a managed name-space dir must survive.
  const userSkill = path.join(codexHome, 'skills', 'my-own-skill');
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# my own thing\n');

  shared.installCodexSurface(PACKAGE_ROOT, codexHome);
  shared.removeManagedCodexSurface(codexHome, PACKAGE_ROOT);

  for (const scriptName of shared.MANAGED_HOOK_SCRIPT_NAMES) {
    assert.ok(!fs.existsSync(path.join(codexHome, 'hooks', scriptName)), `${scriptName} not removed`);
  }
  assert.ok(!fs.existsSync(path.join(codexHome, 'hooks', shared.MANAGED_SURFACE_MARKER)), 'marker not removed');
  assert.ok(!fs.existsSync(path.join(codexHome, 'skills', 'babysit')), 'managed skill not removed');
  assert.ok(fs.existsSync(userSkill), 'user skill wrongly removed');

  const hooksConfig = readHooksConfig(codexHome);
  assert.deepStrictEqual(handlerCommands(hooksConfig), ['echo user-stop']);
  assert.strictEqual(hooksConfig.$schema, 'https://example.com/hooks.schema.json', 'top-level key lost on uninstall');
});

test('legacy purge only deletes artifacts that identify as babysitter', () => {
  const codexHome = tmpdir('bsit-codex-home-');
  const userPrompt = path.join(codexHome, 'prompts', 'plan.md');
  const userSkill = path.join(codexHome, 'skills', 'model');
  fs.mkdirSync(path.dirname(userPrompt), { recursive: true });
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(userPrompt, '# my personal planning prompt\n');
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# my model helper\n');
  const legacyPrompt = path.join(codexHome, 'prompts', 'call.md');
  fs.writeFileSync(legacyPrompt, 'Invoke the babysitter orchestrator\n');

  shared.removeLegacyCodexSurface(codexHome);

  assert.ok(fs.existsSync(userPrompt), 'unrelated user prompt deleted');
  assert.ok(fs.existsSync(userSkill), 'unrelated user skill deleted');
  assert.ok(!fs.existsSync(legacyPrompt), 'babysitter legacy prompt kept');
});

test('rewriteManagedHookCommand fails loudly instead of writing broken commands', () => {
  assert.throws(() => shared.rewriteManagedHookCommand('echo something-else', '/tmp/hooks'));
  assert.throws(() => shared.rewriteManagedHookCommand('bash x/babysitter-proxied-stop.sh', '/tmp/we"ird'));
  assert.strictEqual(
    shared.rewriteManagedHookCommand('bash "x/babysitter-proxied-stop.sh"', '/tmp/hooks'),
    'bash "/tmp/hooks/babysitter-proxied-stop.sh"',
  );
});

test('copyPluginBundle ships hooks, hooks.json, and versions.json', () => {
  const pluginRoot = path.join(tmpdir('bsit-plugin-root-'), 'babysitter');
  shared.copyPluginBundle(PACKAGE_ROOT, pluginRoot);
  for (const entry of ['hooks.json', 'versions.json', '.codex-plugin/plugin.json', 'hooks/babysitter-hook-lib.sh']) {
    assert.ok(fs.existsSync(path.join(pluginRoot, entry)), `bundle missing ${entry}`);
  }
});

if (process.platform !== 'win32') {
  test('hook wrapper pipes the event through adapters-hooks with the right args', () => {
    const sandbox = tmpdir('bsit-hook-exec-');
    const fakeHome = path.join(sandbox, 'home');
    const binDir = path.join(sandbox, 'bin');
    const argsFile = path.join(sandbox, 'args.txt');
    const stdinFile = path.join(sandbox, 'stdin.txt');
    fs.mkdirSync(fakeHome, { recursive: true });
    writeStubBins(binDir, argsFile, stdinFile);

    const script = path.join(PACKAGE_ROOT, 'hooks', 'babysitter-proxied-stop.sh');
    const stdout = execFileSync('bash', [script], {
      cwd: sandbox,
      env: { ...process.env, HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
      input: '{"event":"Stop"}',
      encoding: 'utf8',
    });
    assert.strictEqual(stdout.trim(), '{}');
    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.deepStrictEqual(args, [
      'invoke',
      '--adapter',
      'codex',
      '--handler',
      'babysitter hook:run --harness unified --hook-type stop --json',
      '--json',
    ]);
    assert.strictEqual(fs.readFileSync(stdinFile, 'utf8'), '{"event":"Stop"}');
  });

  test('plugin-bundle copy defers to a live home surface (including CODEX_HOME)', () => {
    for (const useCodexHomeEnv of [false, true]) {
      const sandbox = tmpdir('bsit-hook-dedup-');
      const fakeHome = path.join(sandbox, 'home');
      const codexHome = useCodexHomeEnv ? path.join(sandbox, 'custom-codex-home') : path.join(fakeHome, '.codex');
      const surfaceHooks = path.join(codexHome, 'hooks');
      const binDir = path.join(sandbox, 'bin');
      const argsFile = path.join(sandbox, 'args.txt');
      fs.mkdirSync(fakeHome, { recursive: true });
      writeStubBins(binDir, argsFile);
      writeSurfaceCopy(surfaceHooks);

      const opts = { cwd: sandbox, home: fakeHome, binDir, codexHome: useCodexHomeEnv ? codexHome : undefined };
      const pluginScript = path.join(PACKAGE_ROOT, 'hooks', 'babysitter-proxied-stop.sh');
      const result = runHook(pluginScript, opts);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!fs.existsSync(argsFile), `plugin copy ran despite live surface (CODEX_HOME=${useCodexHomeEnv})`);

      const surfaceResult = runHook(path.join(surfaceHooks, 'babysitter-proxied-stop.sh'), opts);
      assert.strictEqual(surfaceResult.status, 0, surfaceResult.stderr);
      assert.ok(fs.existsSync(argsFile), `surface copy did not run (CODEX_HOME=${useCodexHomeEnv})`);
    }
  });

  test('workspace surface wins over home surface, and works from a subdirectory', () => {
    const sandbox = tmpdir('bsit-hook-precedence-');
    const fakeHome = path.join(sandbox, 'home');
    const workspace = path.join(sandbox, 'ws');
    const subdir = path.join(workspace, 'packages', 'api');
    const homeHooks = path.join(fakeHome, '.codex', 'hooks');
    const wsHooks = path.join(workspace, '.codex', 'hooks');
    const binDir = path.join(sandbox, 'bin');
    const argsFile = path.join(sandbox, 'args.txt');
    fs.mkdirSync(subdir, { recursive: true });
    writeStubBins(binDir, argsFile);
    writeSurfaceCopy(homeHooks);
    writeSurfaceCopy(wsHooks);

    const opts = { cwd: subdir, home: fakeHome, binDir };
    // Home surface copy must defer to the nearer workspace surface.
    const homeResult = runHook(path.join(homeHooks, 'babysitter-proxied-stop.sh'), opts);
    assert.strictEqual(homeResult.status, 0, homeResult.stderr);
    assert.ok(!fs.existsSync(argsFile), 'home surface ran despite workspace surface owning the event');
    // Plugin bundle copy must defer too, even from a subdirectory.
    const pluginResult = runHook(path.join(PACKAGE_ROOT, 'hooks', 'babysitter-proxied-stop.sh'), opts);
    assert.strictEqual(pluginResult.status, 0, pluginResult.stderr);
    assert.ok(!fs.existsSync(argsFile), 'plugin copy ran despite workspace surface owning the event');
    // The workspace surface copy handles it.
    const wsResult = runHook(path.join(wsHooks, 'babysitter-proxied-stop.sh'), opts);
    assert.strictEqual(wsResult.status, 0, wsResult.stderr);
    assert.ok(fs.existsSync(argsFile), 'workspace surface did not run');
  });

  test('a stale marker without scripts does not swallow events', () => {
    const sandbox = tmpdir('bsit-hook-stale-');
    const fakeHome = path.join(sandbox, 'home');
    const staleHooks = path.join(fakeHome, '.codex', 'hooks');
    const binDir = path.join(sandbox, 'bin');
    const argsFile = path.join(sandbox, 'args.txt');
    fs.mkdirSync(staleHooks, { recursive: true });
    fs.writeFileSync(path.join(staleHooks, shared.MANAGED_SURFACE_MARKER), '{}');
    writeStubBins(binDir, argsFile);

    const result = runHook(path.join(PACKAGE_ROOT, 'hooks', 'babysitter-proxied-stop.sh'), {
      cwd: sandbox, home: fakeHome, binDir,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(argsFile), 'plugin copy deferred to a dead surface (marker without scripts)');
  });

  test('hook wrapper survives a missing HOME', () => {
    const sandbox = tmpdir('bsit-hook-nohome-');
    const binDir = path.join(sandbox, 'bin');
    const argsFile = path.join(sandbox, 'args.txt');
    writeStubBins(binDir, argsFile);

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    delete env.HOME;
    delete env.CODEX_HOME;
    const result = spawnSync('bash', [path.join(PACKAGE_ROOT, 'hooks', 'babysitter-proxied-stop.sh')], {
      cwd: sandbox, env, input: '{}', encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, `wrapper failed without HOME: ${result.stderr}`);
    assert.ok(fs.existsSync(argsFile), 'wrapper did not invoke adapters-hooks without HOME');
  });
}

console.log(`\n${passed} integration checks passed`);
