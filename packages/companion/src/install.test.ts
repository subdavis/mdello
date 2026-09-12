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
<string>__MISE_BIN__</string>
<string>__MDELLO_ROOT__</string>
<string>__HOME__</string>
`;

async function fixture(): Promise<{ root: string; home: string; repoRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mdello-install-'));
  const home = join(root, 'home & user');
  const repoRoot = join(root, 'repo & clone');
  await mkdir(join(repoRoot, 'packages/companion'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/pi-extension/dist'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/claude-extension/dist'), { recursive: true });
  await writeFile(join(repoRoot, 'packages/companion/com.mdello.companion.plist'), template);
  await writeFile(
    join(repoRoot, 'packages/pi-extension/dist/index.js'),
    'export default () => {};',
  );
  await writeFile(join(repoRoot, 'packages/claude-extension/dist/index.js'), 'await 0;');
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
      misePath: '/opt/mise',
      uid: 42,
      run,
    };
    await installMacOS(options);
    await installMacOS(options);

    const destination = join(home, 'Library/LaunchAgents/com.mdello.companion.plist');
    const plist = await readFile(destination, 'utf8');
    assert.match(plist, /<string>\/opt\/mise<\/string>/);
    assert.match(plist, /repo &amp; clone/);
    assert.match(plist, /home &amp; user/);
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

test('Claude install links the hook and registers every lifecycle event', async () => {
  const { root, home, repoRoot } = await fixture();
  const destination = join(home, '.claude/hooks/mdello-companion.js');

  try {
    await installClaude({ home, repoRoot });
    await installClaude({ home, repoRoot });

    assert.equal(
      await readlink(destination),
      join(repoRoot, 'packages/claude-extension/dist/index.js'),
    );
    const { hooks } = (await readSettings(home)) as unknown as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    assert.deepEqual(Object.keys(hooks), [
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'Notification',
      'Stop',
      'SessionEnd',
    ]);
    for (const entries of Object.values(hooks)) {
      assert.equal(entries.length, 1, 'reinstall must not duplicate entries');
      assert.equal(entries[0]?.hooks[0]?.command, `node '${destination}'`);
    }
    assert.equal(hooks.PostToolUse?.[0]?.matcher, 'Edit|MultiEdit|Write');
    assert.equal(hooks.SessionStart?.[0]?.matcher, undefined);

    await uninstallClaude({ home, repoRoot });
    await uninstallClaude({ home, repoRoot });
    await assert.rejects(lstat(destination));
    assert.deepEqual((await readSettings(home)).hooks, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install preserves unrelated settings and hooks', async () => {
  const { root, home, repoRoot } = await fixture();
  const other = { type: 'command', command: 'tput bel > /dev/tty' };

  try {
    await writeSettings(home, {
      theme: 'dark',
      hooks: {
        Stop: [{ matcher: '*', hooks: [other] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [other] }],
      },
    });
    await installClaude({ home, repoRoot });

    const settings = (await readSettings(home)) as unknown as {
      theme: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.hooks.Stop?.length, 2, 'companion Stop hook appends to existing');
    assert.deepEqual(settings.hooks.Stop?.[0]?.hooks, [other]);
    assert.match(settings.hooks.Stop?.[1]?.hooks[0]?.command ?? '', /mdello-companion\.js/);
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }]);

    await uninstallClaude({ home, repoRoot });
    assert.deepEqual((await readSettings(home)).hooks, {
      Stop: [{ matcher: '*', hooks: [other] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [other] }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install leaves a companion hook sharing a group with another tool', async () => {
  const { root, home, repoRoot } = await fixture();
  const other = { type: 'command', command: 'notify.sh' };

  try {
    await installClaude({ home, repoRoot });
    const settings = (await readSettings(home)) as unknown as {
      hooks: Record<string, { hooks: unknown[] }[]>;
    };
    const group = settings.hooks.Stop?.[0];
    assert.ok(group);
    group.hooks.push(other);
    await writeSettings(home, settings);

    await uninstallClaude({ home, repoRoot });
    assert.deepEqual((await readSettings(home)).hooks, { Stop: [{ hooks: [other] }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install requires a built bundle', async () => {
  const { root, home, repoRoot } = await fixture();

  try {
    await rm(join(repoRoot, 'packages/claude-extension/dist'), { recursive: true, force: true });
    await assert.rejects(installClaude({ home, repoRoot }), /yarn build:claude-extension/);
    await assert.rejects(lstat(join(home, '.claude/hooks/mdello-companion.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install refuses to rewrite settings it cannot understand', async () => {
  const { root, home, repoRoot } = await fixture();

  try {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{ not json');
    await assert.rejects(installClaude({ home, repoRoot }), /Cannot parse/);

    await writeSettings(home, { hooks: [] });
    await assert.rejects(installClaude({ home, repoRoot }), /Expected an object at "hooks"/);

    await writeSettings(home, { hooks: { Stop: 'bell' } });
    await assert.rejects(installClaude({ home, repoRoot }), /Expected an array at "hooks.Stop"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude install and uninstall preserve a non-symlink hook path', async () => {
  const { root, home, repoRoot } = await fixture();
  const destination = join(home, '.claude/hooks/mdello-companion.js');

  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'mine');
    await assert.rejects(installClaude({ home, repoRoot }), /Cannot replace non-symlink/);
    await assert.rejects(uninstallClaude({ home, repoRoot }), /Refusing to remove non-symlink/);
    assert.equal(await readFile(destination, 'utf8'), 'mine');
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
    assert.match(installed[1] ?? '', /Installed Claude hooks/);

    const uninstalled = await uninstallIntegrations(undefined, {
      home,
      repoRoot,
      platform: 'linux',
    });
    assert.equal(uninstalled.length, 2);
    assert.match(uninstalled[0] ?? '', /Removed Pi extension/);
    assert.match(uninstalled[1] ?? '', /Removed Claude hooks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
