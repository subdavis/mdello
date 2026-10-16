import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  installClaude,
  installCodex,
  installIntegrations,
  installMacOS,
  installOpencode,
  installPi,
  resolveExecutable,
  uninstallClaude,
  uninstallCodex,
  uninstallIntegrations,
  uninstallMacOS,
  uninstallOpencode,
  uninstallPi,
} from './install.ts';

const template = `
<string>__NODE_BIN__</string>
<string>__MDELLO_ROOT__</string>
<string>__HOME__</string>
<string>__XDG_CONFIG_HOME__</string>
<string>__XDG_STATE_HOME__</string>
<string>__COMPANION_STDOUT__</string>
<string>__COMPANION_STDERR__</string>
__HERDR_ENV__
__GH_ENV__
__JIRA_ENV__
`;

async function fixture(): Promise<{ root: string; home: string; repoRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mdello-install-'));
  const home = join(root, 'home & user');
  const repoRoot = join(root, 'repo & clone');
  await mkdir(join(repoRoot, 'packages/companion'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/pi-extension/dist'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/opencode-extension/dist'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/claude-extension'), { recursive: true });
  await writeFile(join(repoRoot, 'packages/companion/com.mdello.companion.plist'), template);
  await writeFile(
    join(repoRoot, 'packages/pi-extension/dist/index.js'),
    'export default () => {};',
  );
  await writeFile(
    join(repoRoot, 'packages/opencode-extension/dist/index.js'),
    'export default async () => ({});',
  );
  await writeFile(join(repoRoot, 'packages/claude-extension/index.ts'), 'export default 0;');
  return { root, home, repoRoot };
}

async function readSettings(home: string): Promise<Record<string, never>> {
  return JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
}

async function writeSettings(home: string, settings: unknown): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify(settings, null, 2));
}

test('macOS install updates plist and reloads launchd idempotently', async () => {
  const { root, home, repoRoot } = await fixture();
  const calls: string[][] = [];
  const questions: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'launchctl' && args[0] === 'bootout') throw new Error('not loaded');
    return {
      stdout:
        command === 'which' && ['herdr', 'gh', 'jira'].includes(args[0] ?? '')
          ? process.execPath
          : '',
    };
  };

  try {
    const options = {
      home,
      repoRoot,
      platform: 'darwin' as const,
      uid: 42,
      prompt: async (question: string) => {
        questions.push(question);
        return 'y';
      },
      environment: {
        XDG_CONFIG_HOME: join(root, 'xdg & config'),
        XDG_STATE_HOME: join(root, 'xdg & state'),
      },
      run,
    };
    await installMacOS(options);
    await installMacOS(options);

    const destination = join(home, 'Library/LaunchAgents/com.mdello.companion.plist');
    const plist = await readFile(destination, 'utf8');
    assert.ok(plist.includes(`<string>${process.execPath}</string>`));
    assert.match(plist, /repo &amp; clone/);
    assert.match(plist, /home &amp; user/);
    assert.match(plist, /xdg &amp; config/);
    assert.match(plist, /xdg &amp; state/);
    assert.match(plist, /<key>HERDR_PATH<\/key>\s*<string>.*node<\/string>/);
    assert.match(plist, /<key>GH_PATH<\/key>\s*<string>.*node<\/string>/);
    assert.match(plist, /<key>JIRA_PATH<\/key>\s*<string>.*node<\/string>/);
    assert.doesNotMatch(plist, /<key>JIRA_API_TOKEN<\/key>/);
    assert.doesNotMatch(plist, /<key>PATH<\/key>/);
    assert.deepEqual(questions, [
      `NODE_PATH=${process.execPath} Y/n? `,
      `HERDR_PATH=${process.execPath} Y/n? `,
      `GH_PATH=${process.execPath} Y/n? `,
      `JIRA_PATH=${process.execPath} Y/n? `,
      `NODE_PATH=${process.execPath} Y/n? `,
      `HERDR_PATH=${process.execPath} Y/n? `,
      `GH_PATH=${process.execPath} Y/n? `,
      `JIRA_PATH=${process.execPath} Y/n? `,
    ]);
    assert.equal(
      calls.filter(([command, action]) => command === 'launchctl' && action === 'bootstrap').length,
      2,
    );
    assert.equal(
      calls.filter(([command, action]) => command === 'launchctl' && action === 'bootout').length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS install migrates legacy files without replacing XDG files', async () => {
  const { root, home, repoRoot } = await fixture();
  const configRoot = join(root, 'config');
  const stateRoot = join(root, 'state');
  const legacy = join(home, '.mdello');
  const configDirectory = join(configRoot, 'mdello');
  const stateDirectory = join(stateRoot, 'mdello');
  const calls: string[][] = [];

  try {
    await mkdir(legacy, { recursive: true });
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(legacy, 'companion.json'), 'legacy config');
    await writeFile(join(legacy, 'companion.jsonl'), 'legacy data');
    await writeFile(join(legacy, 'companion.log'), 'legacy stdout');
    await writeFile(join(legacy, 'companion-error.log'), 'legacy stderr');
    await writeFile(join(configDirectory, 'companion.json'), 'current config');

    await installMacOS({
      home,
      repoRoot,
      platform: 'darwin',
      uid: 42,
      environment: { XDG_CONFIG_HOME: configRoot, XDG_STATE_HOME: stateRoot },
      prompt: async () => 'y',
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'bootout') {
          assert.equal(await readFile(join(legacy, 'companion.jsonl'), 'utf8'), 'legacy data');
        }
        return { stdout: '' };
      },
    });

    const launchCalls = calls.filter(([command]) => command === 'launchctl');
    assert.equal(launchCalls[0]?.[1], 'bootout');
    assert.equal(launchCalls.at(-1)?.[1], 'bootstrap');
    assert.equal(await readFile(join(configDirectory, 'companion.json'), 'utf8'), 'current config');
    assert.equal(await readFile(join(legacy, 'companion.json'), 'utf8'), 'legacy config');
    assert.equal(await readFile(join(stateDirectory, 'companion.jsonl'), 'utf8'), 'legacy data');
    assert.equal(await readFile(join(stateDirectory, 'companion.log'), 'utf8'), 'legacy stdout');
    assert.equal(
      await readFile(join(stateDirectory, 'companion-error.log'), 'utf8'),
      'legacy stderr',
    );
    await assert.rejects(lstat(join(legacy, 'companion.jsonl')));

    await rm(join(legacy, 'companion.json'));
    await installMacOS({
      home,
      repoRoot,
      platform: 'darwin',
      uid: 42,
      environment: { XDG_CONFIG_HOME: configRoot, XDG_STATE_HOME: stateRoot },
      prompt: async () => 'y',
      run: async () => ({ stdout: '' }),
    });
    await assert.rejects(lstat(legacy));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS install rejects a node path launchd could not exec', async () => {
  const { root, home, repoRoot } = await fixture();
  const run = async () => ({ stdout: '' });

  try {
    const options = {
      home,
      repoRoot,
      platform: 'darwin' as const,
      uid: 42,
      run,
      prompt: async () => 'y',
    };
    await assert.rejects(installMacOS({ ...options, nodePath: 'node' }), /not absolute/);
    await assert.rejects(
      installMacOS({ ...options, nodePath: join(root, 'no-such-node') }),
      /missing, not absolute, or not executable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveExecutable accepts a replacement path after rejecting the discovered path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-executable-'));
  const replacement = join(root, 'herdr');
  await writeFile(replacement, '#!/bin/sh\n');
  await chmod(replacement, 0o755);
  const answers = ['n', replacement, 'y'];

  try {
    assert.equal(
      await resolveExecutable('HERDR_PATH', process.execPath, false, async () => {
        const answer = answers.shift();
        assert.ok(answer);
        return answer;
      }),
      replacement,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveExecutable accepts the discovered path by default', async () => {
  assert.equal(
    await resolveExecutable('NODE_PATH', process.execPath, true, async () => ''),
    process.execPath,
  );
});

test('resolveExecutable skips an optional executable when its replacement is blank', async () => {
  const answers = ['n', ''];
  assert.equal(
    await resolveExecutable('HERDR_PATH', process.execPath, false, async () => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('Missing test answer.');
      return answer;
    }),
    undefined,
  );
});

test('macOS install omits herdr when it cannot be discovered', async () => {
  const { root, home, repoRoot } = await fixture();
  try {
    await installMacOS({
      home,
      repoRoot,
      platform: 'darwin',
      uid: 42,
      prompt: async () => 'y',
      run: async () => ({ stdout: '' }),
    });
    const plist = await readFile(
      join(home, 'Library/LaunchAgents/com.mdello.companion.plist'),
      'utf8',
    );
    assert.doesNotMatch(plist, /HERDR_PATH/);
    assert.doesNotMatch(plist, /<key>PATH<\/key>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS uninstall tolerates an absent service and plist', async () => {
  const { root, home, repoRoot } = await fixture();
  const run = async () => {
    throw new Error('not loaded');
  };

  try {
    const options = { home, repoRoot, platform: 'darwin' as const, uid: 42, run };
    await uninstallMacOS(options);
    await uninstallMacOS(options);
    await assert.rejects(lstat(join(home, 'Library/LaunchAgents/com.mdello.companion.plist')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi install links the bundle and uninstall is idempotent', async () => {
  const { root, home, repoRoot } = await fixture();
  const destination = join(home, '.pi/agent/extensions/mdello-companion.js');
  const source = join(repoRoot, 'packages/pi-extension/dist/index.js');

  try {
    await installPi({ home, repoRoot });
    await installPi({ home, repoRoot });
    assert.equal(await readlink(destination), source);

    await uninstallPi({ home, repoRoot });
    await uninstallPi({ home, repoRoot });
    await assert.rejects(lstat(destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi install requires a built bundle', async () => {
  const { root, home, repoRoot } = await fixture();

  try {
    await rm(join(repoRoot, 'packages/pi-extension/dist'), { recursive: true, force: true });
    await assert.rejects(installPi({ home, repoRoot }), /yarn build:pi-extension/);
    await assert.rejects(lstat(join(home, '.pi/agent/extensions/mdello-companion.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi install and uninstall replace the pre-bundle directory symlink', async () => {
  const { root, home, repoRoot } = await fixture();
  const legacy = join(home, '.pi/agent/extensions/mdello-companion');

  try {
    await mkdir(dirname(legacy), { recursive: true });
    await symlink(join(repoRoot, 'packages/pi-extension'), legacy, 'dir');
    await installPi({ home, repoRoot });
    await assert.rejects(lstat(legacy));

    await symlink(join(repoRoot, 'packages/pi-extension'), legacy, 'dir');
    await uninstallPi({ home, repoRoot });
    await assert.rejects(lstat(legacy));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi install and uninstall preserve non-symlink paths', async () => {
  const { root, home, repoRoot } = await fixture();
  const destination = join(home, '.pi/agent/extensions/mdello-companion.js');

  try {
    await mkdir(destination, { recursive: true });
    await assert.rejects(installPi({ home, repoRoot }), /Cannot replace non-symlink/);
    await assert.rejects(uninstallPi({ home, repoRoot }), /Refusing to remove non-symlink/);
    assert.equal((await lstat(destination)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenCode install links the bundle in the XDG plugin directory', async () => {
  const { root, home, repoRoot } = await fixture();
  const configHome = join(root, 'config');
  const destination = join(configHome, 'opencode/plugins/mdello-companion.js');
  const source = join(repoRoot, 'packages/opencode-extension/dist/index.js');

  try {
    const options = { home, repoRoot, environment: { XDG_CONFIG_HOME: configHome } };
    await installOpencode(options);
    await installOpencode(options);
    assert.equal(await readlink(destination), source);

    await uninstallOpencode(options);
    await uninstallOpencode(options);
    await assert.rejects(lstat(destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenCode install requires a built bundle and preserves unmanaged paths', async () => {
  const { root, home, repoRoot } = await fixture();
  const destination = join(home, '.config/opencode/plugins/mdello-companion.js');

  try {
    await rm(join(repoRoot, 'packages/opencode-extension/dist'), { recursive: true, force: true });
    await assert.rejects(installOpencode({ home, repoRoot }), /build:opencode-extension/);

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'unmanaged');
    await mkdir(join(repoRoot, 'packages/opencode-extension/dist'), { recursive: true });
    await writeFile(
      join(repoRoot, 'packages/opencode-extension/dist/index.js'),
      'export default 0',
    );
    await assert.rejects(installOpencode({ home, repoRoot }), /Cannot replace non-symlink/);
    await assert.rejects(uninstallOpencode({ home, repoRoot }), /Refusing to remove non-symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install writes a self-contained plugin and never touches settings', async () => {
  const { root, home, repoRoot } = await fixture();
  const directory = join(home, '.claude/skills/mdello-companion');
  const endpoint = 'http://127.0.0.1:51618';

  try {
    await writeSettings(home, { theme: 'dark', hooks: { Stop: [{ hooks: ['keep me'] }] } });
    await installClaude({ home, repoRoot, endpoint });
    await installClaude({ home, repoRoot, endpoint });

    const manifest = JSON.parse(
      await readFile(join(directory, '.claude-plugin/plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'mdello-companion');

    const { hooks } = JSON.parse(await readFile(join(directory, 'hooks/hooks.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; url?: string }[] }[]>;
    };
    assert.deepEqual(
      Object.keys(hooks).sort((a, b) => a.localeCompare(b)),
      [
        'Elicitation',
        'ElicitationResult',
        'Notification',
        'PermissionDenied',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit',
      ],
    );
    // Claude Code rejects http hooks on SessionStart, so only session boundary hooks shell out.
    for (const event of Object.keys(hooks).filter(
      (event) => event !== 'SessionStart' && event !== 'SessionEnd',
    )) {
      assert.equal(hooks[event]?.[0]?.hooks[0]?.type, 'http', `${event} must not spawn a process`);
      assert.equal(hooks[event]?.[0]?.hooks[0]?.url, `${endpoint}/hooks/claude`);
    }
    assert.equal(hooks.PreToolUse?.[0]?.matcher, 'AskUserQuestion');
    assert.equal(hooks.PostToolUse?.[0]?.matcher, undefined);

    assert.deepEqual(
      await readSettings(home),
      { theme: 'dark', hooks: { Stop: [{ hooks: ['keep me'] }] } },
      'settings.json must be left exactly as the user wrote it',
    );

    await uninstallClaude({ home, repoRoot });
    await uninstallClaude({ home, repoRoot });
    await assert.rejects(lstat(directory));
    assert.deepEqual(await readSettings(home), {
      theme: 'dark',
      hooks: { Stop: [{ hooks: ['keep me'] }] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install targets the configured companion port', async () => {
  const { root, home, repoRoot } = await fixture();

  try {
    await installClaude({ home, repoRoot, endpoint: 'http://127.0.0.1:41337/' });
    const { hooks } = JSON.parse(
      await readFile(join(home, '.claude/skills/mdello-companion/hooks/hooks.json'), 'utf8'),
    ) as { hooks: Record<string, { hooks: { url?: string; command?: string }[] }[]> };
    assert.equal(hooks.Stop?.[0]?.hooks[0]?.url, 'http://127.0.0.1:41337/hooks/claude');
    assert.match(hooks.SessionStart?.[0]?.hooks[0]?.command ?? '', /41337\/hooks\/claude/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install and uninstall spare a plugin directory they do not own', async () => {
  const { root, home, repoRoot } = await fixture();
  const directory = join(home, '.claude/skills/mdello-companion');

  try {
    await mkdir(join(directory, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(directory, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'mdello-companion' }),
    );
    await assert.rejects(installClaude({ home, repoRoot }), /Cannot replace unmanaged/);
    await assert.rejects(uninstallClaude({ home, repoRoot }), /Refusing to remove unmanaged/);
    assert.equal((await lstat(directory)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex install merges hooks and uninstall removes only owned entries', async () => {
  const { root, home } = await fixture();
  const path = join(home, '.codex/hooks.json');
  const original = {
    description: 'user hooks',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] },
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(original), { mode: 0o600 });
    await installCodex({ home, endpoint: 'http://127.0.0.1:41337/' });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const installed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(installed.hooks.Stop.length, 2);
    assert.match(installed.hooks.Stop[1].hooks[0].command, /41337\/hooks\/codex/);
    await installCodex({ home });
    const repeated = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(repeated.hooks.Stop.length, 2);
    repeated.hooks.Stop[1].hooks.push({ type: 'command', command: 'echo added' });
    await writeFile(path, JSON.stringify(repeated));
    await uninstallCodex({ home });
    const remaining = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(remaining.description, original.description);
    assert.deepEqual(remaining.hooks.Stop, [
      ...original.hooks.Stop,
      { hooks: [{ type: 'command', command: 'echo added' }] },
    ]);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await uninstallCodex({ home });
    await writeFile(path, '{ invalid');
    await assert.rejects(installCodex({ home }), SyntaxError);
    assert.equal(await readFile(path, 'utf8'), '{ invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex install and uninstall respect CODEX_HOME and preserve unrelated hooks', async () => {
  const { root, home } = await fixture();
  const directory = join(root, 'custom-codex');
  const path = join(directory, 'hooks.json');
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } };
  try {
    await mkdir(directory);
    await writeFile(path, JSON.stringify(original));
    const options = { home, environment: { CODEX_HOME: directory } };
    assert.match(await installCodex(options), /custom-codex/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).hooks.Stop.length, 2);
    await assert.rejects(lstat(join(home, '.codex/hooks.json')), { code: 'ENOENT' });
    await uninstallCodex(options);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate install and uninstall skip macOS integration on other platforms', async () => {
  const { root, home, repoRoot } = await fixture();

  try {
    const installed = await installIntegrations(undefined, { home, repoRoot, platform: 'linux' });
    assert.equal(installed.length, 4);
    assert.match(installed[0] ?? '', /Installed Pi extension/);
    assert.match(installed[1] ?? '', /Installed OpenCode extension/);
    assert.match(installed[2] ?? '', /Installed Claude plugin/);
    assert.match(installed[3] ?? '', /Installed Codex hooks/);

    const uninstalled = await uninstallIntegrations(undefined, {
      home,
      repoRoot,
      platform: 'linux',
    });
    assert.equal(uninstalled.length, 4);
    assert.match(uninstalled[0] ?? '', /Removed Pi extension/);
    assert.match(uninstalled[1] ?? '', /Removed OpenCode extension/);
    assert.match(uninstalled[2] ?? '', /Removed Claude plugin/);
    assert.match(uninstalled[3] ?? '', /Removed Codex hooks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
