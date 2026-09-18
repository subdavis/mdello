import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { discoverExecutable } from './executables.ts';

test('discovers the first executable file on PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-executables-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    await writeFile(join(first, 'herdr'), 'not executable');
    const executable = join(second, 'herdr');
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);

    assert.equal(
      await discoverExecutable('herdr', { PATH: `${first}${delimiter}${second}` }),
      executable,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns undefined when PATH is absent or has no executable', async () => {
  const emptyDirectory = await mkdtemp(join(tmpdir(), 'mdello-executables-empty-'));
  try {
    assert.equal(await discoverExecutable('herdr', {}), undefined);
    assert.equal(await discoverExecutable('herdr', { PATH: emptyDirectory }), undefined);
  } finally {
    await rm(emptyDirectory, { recursive: true, force: true });
  }
});
