import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WEB_ORIGIN,
  findBoardForPath,
  loadBoards,
  loadConfig,
  loadWebOrigin,
  registerBoard,
  resolveCard,
} from './boards.ts';

test('registers multiple boards and updates a moved board by uuid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-boards-'));
  try {
    const configFile = join(root, 'state', 'companion.json');
    await mkdir(join(root, 'state'));
    await writeFile(configFile, JSON.stringify({ customSetting: { enabled: true } }));
    const boards = await loadBoards(configFile);
    await registerBoard(configFile, boards, { uuid: 'board-a', path: join(root, 'first') });
    await registerBoard(configFile, boards, { uuid: 'board-b', path: join(root, 'second') });

    assert.equal(boards.length, 2);
    assert.equal(findBoardForPath(join(root, 'first', 'card.md'), boards)?.uuid, 'board-a');
    assert.equal(findBoardForPath(join(root, 'unknown', 'card.md'), boards), undefined);

    await registerBoard(configFile, boards, { uuid: 'board-a', path: join(root, 'moved') });
    assert.equal(boards.length, 2);
    assert.equal(findBoardForPath(join(root, 'first', 'card.md'), boards), undefined);
    assert.equal(findBoardForPath(join(root, 'moved', 'card.md'), boards)?.uuid, 'board-a');
    assert.deepEqual(
      (await loadBoards(configFile)).map(({ uuid }) => uuid).sort((a, b) => a.localeCompare(b)),
      ['board-a', 'board-b'],
    );
    assert.deepEqual(((await loadConfig(configFile)) as Record<string, unknown>).customSetting, {
      enabled: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads a configured web origin and safely defaults invalid values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-boards-'));
  try {
    const configFile = join(root, 'companion.json');
    assert.equal(await loadWebOrigin(configFile), DEFAULT_WEB_ORIGIN);

    await writeFile(configFile, JSON.stringify({ webOrigin: 'https://mdello.example/apps/board' }));
    assert.equal(await loadWebOrigin(configFile), 'https://mdello.example');

    await writeFile(configFile, JSON.stringify({ webOrigin: 'file:///tmp/mdello.html' }));
    assert.equal(await loadWebOrigin(configFile), DEFAULT_WEB_ORIGIN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves card identity only for registered root markdown cards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-boards-'));
  try {
    const boardPath = join(root, 'board');
    const cardPath = join(boardPath, 'card.md');
    await mkdir(join(boardPath, 'archive'), { recursive: true });
    await writeFile(cardPath, '---\nuuid: card-a\ntitle: Card\n---\n\nBody');
    await writeFile(join(boardPath, 'missing-uuid.md'), '# Card');
    await writeFile(join(boardPath, 'archive', 'old.md'), '---\nuuid: old\n---\n');
    const boards = [{ uuid: 'board-a', path: boardPath, updatedAt: new Date().toISOString() }];

    assert.deepEqual(await resolveCard(cardPath, boards), {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath,
    });
    assert.equal(await resolveCard(join(boardPath, 'missing-uuid.md'), boards), undefined);
    assert.equal(await resolveCard(join(boardPath, 'archive', 'old.md'), boards), undefined);
    assert.equal(await resolveCard(join(root, 'unknown.md'), boards), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
