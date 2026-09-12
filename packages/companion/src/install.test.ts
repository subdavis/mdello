import assert from 'node:assert/strict';
import {
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
  installIntegrations,
  installMacOS,
  installPi,
  uninstallClaude,
  uninstallIntegrations,
  uninstallMacOS,
  uninstallPi,
} from './install.ts';

const template = `
<string>__NODE_BIN__</string>
<string>__MDELLO_ROOT__</string>
<string>__HOME__</string>
<string>__PATH__</string>
`;

async function fixture(): Promise<{ root: string; home: string; repoRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mdello-install-'));
  const home = join(root, 'home & user');
  const repoRoot = join(root, 'repo & clone');
  await mkdir(join(repoRoot, 'packages/companion'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/pi-extension/dist'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/claude-extension'), { recursive: true });
  await writeFile(join(repoRoot, 'packages/companion/com.mdello.companion.plist'), template);
  await writeFile(
    join(repoRoot, 'packages/pi-extension/dist/index.js'),
    'export default () => {};',
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
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'launchctl' && args[0] === 'bootout') throw new Error('not loaded');
    return { stdout: '' };
  };

  try {
    const options = {
      home,
      repoRoot,
      platform: 'darwin' as const,
      uid: 42,
      pathEnv: '/opt/homebrew/bin:/usr/bin',
      run,
    };
    await installMacOS(options);
    await installMacOS(options);

    const destination = join(home, 'Library/LaunchAgents/com.mdello.companion.plist');
    const plist = await readFile(destination, 'utf8');
    assert.ok(plist.includes(`<string>${process.execPath}</string>`));
    assert.match(plist, /repo &amp; clone/);
    assert.match(plist, /home &amp; user/);
    assert.ok(plist.includes('<string>/opt/homebrew/bin:/usr/bin</string>'));
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

test('macOS install rejects a node path launchd could not exec', async () => {
  const { root, home, repoRoot } = await fixture();
  const run = async () => ({ stdout: '' });

  try {
    const options = { home, repoRoot, platform: 'darwin' as const, uid: 42, run };
    await assert.rejects(installMacOS({ ...options, nodePath: 'node' }), /must be absolute/);
    await assert.rejects(
      installMacOS({ ...options, nodePath: join(root, 'no-such-node') }),
      /missing or not executable/,
    );
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

test('Claude install writes a self-contained plugin and never touches settings', async () => {
  const { root, home, repoRoot } = await fixture();
  const directory = join(home, '.claude/skills/mdello-companion');
  const endpoint = 'http://127.0.0.1:31337';

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
    assert.deepEqual(Object.keys(hooks).sort(), [
      'Notification',
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    // Claude Code rejects http hooks on SessionStart, so only those two shell out.
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop']) {
      assert.equal(hooks[event]?.[0]?.hooks[0]?.type, 'http', `${event} must not spawn a process`);
      assert.equal(hooks[event]?.[0]?.hooks[0]?.url, `${endpoint}/hooks/claude`);
    }
    assert.equal(hooks.PostToolUse?.[0]?.matcher, 'Edit|MultiEdit|Write');

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

test('aggregate install and uninstall skip macOS integration on other platforms', async () => {
  const { root, home, repoRoot } = await fixture();

  try {
    const installed = await installIntegrations(undefined, { home, repoRoot, platform: 'linux' });
    assert.equal(installed.length, 2);
    assert.match(installed[0] ?? '', /Installed Pi extension/);
    assert.match(installed[1] ?? '', /Installed Claude plugin/);

    const uninstalled = await uninstallIntegrations(undefined, {
      home,
      repoRoot,
      platform: 'linux',
    });
    assert.equal(uninstalled.length, 2);
    assert.match(uninstalled[0] ?? '', /Removed Pi extension/);
    assert.match(uninstalled[1] ?? '', /Removed Claude plugin/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
