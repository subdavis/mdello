import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig, writeConfig } from '../src/fs/config.ts';
import { ensureCardUuid, parseFile } from '../src/fs/frontmatter.ts';
import { promptForColumnMigration } from '../src/migrations/folderColumns.ts';

class MemoryFileHandle {
  kind = 'file';
  lastModified = Date.now();

  constructor(name, content = '') {
    this.name = name;
    this.content = content;
  }

  async getFile() {
    return {
      lastModified: this.lastModified,
      text: async () => this.content,
    };
  }

  async createWritable() {
    return {
      write: async (content) => {
        this.content = String(content);
        this.lastModified += 1;
      },
      close: async () => {},
    };
  }
}

class MemoryDirectoryHandle {
  kind = 'directory';
  entries = new Map();

  constructor(name) {
    this.name = name;
  }

  file(name, content = '') {
    const handle = new MemoryFileHandle(name, content);
    this.entries.set(name, handle);
    return handle;
  }

  directory(name) {
    const handle = new MemoryDirectoryHandle(name);
    this.entries.set(name, handle);
    return handle;
  }

  async *values() {
    yield* this.entries.values();
  }

  async getFileHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing?.kind === 'file') return existing;
    if (existing || !options.create) throw new DOMException('Not found', 'NotFoundError');
    return this.file(name);
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing?.kind === 'directory') return existing;
    if (existing || !options.create) throw new DOMException('Not found', 'NotFoundError');
    return this.directory(name);
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new DOMException('Not found', 'NotFoundError');
  }
}

test('reads and writes companion setting', async () => {
  const root = new MemoryDirectoryHandle('board');
  root.file('mdello.yml', 'path: /tmp/board\n');
  const config = await readConfig(root);
  assert.equal(config.companion, false);

  config.companion = true;
  await writeConfig(root, config);
  assert.equal((await readConfig(root)).companion, true);
  assert.match(root.entries.get('mdello.yml').content, /^companion: true$/m);

  root.file('mdello.yml', 'companion: yes\n');
  assert.equal((await readConfig(root)).companion, false);
});

test('migrates folder columns into config and root card frontmatter', async () => {
  const root = new MemoryDirectoryHandle('board');
  root.file('mdello.yml', 'path: /tmp/board\n');
  root.directory('archive');
  root.directory('1-todo').file('first.md', '---\ntitle: First\norder: 1\n---\n\nBody');
  root.directory('2-doing').file('second.md', '---\ntitle: Second\n---\n\nWork');

  let prompt = '';
  const migrated = await promptForColumnMigration(root, (message) => {
    prompt = message;
    return true;
  });

  assert.equal(migrated, true);
  assert.match(prompt, /2 folder columns containing 2 cards/);
  assert.deepEqual((await readConfig(root)).columns, ['Todo', 'Doing']);
  assert.equal(root.entries.has('1-todo'), false);
  assert.equal(root.entries.has('2-doing'), false);
  const first = parseFile(root.entries.get('first.md').content).data;
  const second = parseFile(root.entries.get('second.md').content).data;
  assert.equal(first.column, 'Todo');
  assert.equal(second.column, 'Doing');
  assert.match(first.uuid, /^[0-9a-f-]{36}$/);
  assert.match(second.uuid, /^[0-9a-f-]{36}$/);
});

test('does not offer migration for folders containing no cards', async () => {
  const root = new MemoryDirectoryHandle('board');
  root.file('mdello.yml', 'path: /tmp/board\n');
  root.directory('archive');
  root.directory('attachments');
  root.directory('.mdello');
  root.directory('empty-folder');
  let prompts = 0;

  assert.equal(
    await promptForColumnMigration(root, () => {
      prompts += 1;
      return true;
    }),
    false,
  );
  assert.equal(prompts, 0);
});

test('shares one prompt across concurrent migration checks', async () => {
  const root = new MemoryDirectoryHandle('board');
  root.file('mdello.yml', 'path: /tmp/board\n');
  root.directory('1-todo').file('card.md', '# Card');
  let prompts = 0;
  const confirm = () => {
    prompts += 1;
    return true;
  };

  assert.deepEqual(
    await Promise.all([
      promptForColumnMigration(root, confirm),
      promptForColumnMigration(root, confirm),
    ]),
    [true, true],
  );
  assert.equal(prompts, 1);
});

test('creates missing UUIDs and preserves existing identity', () => {
  const missing = {};
  const generated = ensureCardUuid(missing);
  assert.equal(generated.created, true);
  assert.match(generated.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(missing.uuid, generated.uuid);

  const existing = { uuid: generated.uuid };
  assert.deepEqual(ensureCardUuid(existing), { uuid: generated.uuid, created: false });
});

test('leaves a legacy board untouched when migration is declined', async () => {
  const root = new MemoryDirectoryHandle('board');
  root.file('mdello.yml', 'path: /tmp/board\n');
  root.directory('1-todo').file('card.md', '# Card');

  assert.equal(await promptForColumnMigration(root, () => false), false);
  assert.equal(root.entries.has('1-todo'), true);
  assert.equal(root.entries.has('card.md'), false);
  assert.deepEqual((await readConfig(root)).columns, []);
});
