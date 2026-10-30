import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sync } from './sync.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-sync-'));
  const src = join(dir, 'src');
  const home = join(dir, 'home');
  mkdirSync(join(src, 'mods/m'), { recursive: true });
  writeFileSync(join(src, 'mods/m/main.js'), 'v1');
  return { src, home, statePath: join(dir, 'state.json') };
}

test('copies new files and repo edits', () => {
  const opts = setup();
  assert.deepEqual(sync(opts), { written: ['mods/m/main.js'], conflicts: [] });
  writeFileSync(join(opts.src, 'mods/m/main.js'), 'v2');
  assert.deepEqual(sync(opts).written, ['mods/m/main.js']);
  assert.match(
    readFileSync(join(opts.home, 'mods/m/main.js'), 'utf8'),
    /^\/\/ GENERATED .*\n.*\nv2$/,
  );
});

test('only .js files get the header', () => {
  const opts = setup();
  writeFileSync(join(opts.src, 'mods/m/mod.json'), '{}');
  sync(opts);
  assert.equal(readFileSync(join(opts.home, 'mods/m/mod.json'), 'utf8'), '{}');
});

test('keeps edits made in Herdr home unless forced', () => {
  const opts = setup();
  sync(opts);
  writeFileSync(join(opts.home, 'mods/m/main.js'), 'edited in herdr');
  writeFileSync(join(opts.src, 'mods/m/main.js'), 'v2');
  assert.deepEqual(sync(opts), { written: [], conflicts: ['mods/m/main.js'] });
  assert.equal(readFileSync(join(opts.home, 'mods/m/main.js'), 'utf8'), 'edited in herdr');
  assert.equal(sync(opts).conflicts.length, 1);
  assert.deepEqual(sync({ ...opts, force: true }).written, ['mods/m/main.js']);
});

test('an unsynced file already in Herdr home counts as edited there', () => {
  const opts = setup();
  mkdirSync(join(opts.home, 'mods/m'), { recursive: true });
  writeFileSync(join(opts.home, 'mods/m/main.js'), 'theirs');
  assert.deepEqual(sync(opts).conflicts, ['mods/m/main.js']);
});
