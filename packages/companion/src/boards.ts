import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { type Frontmatter, parseFile, readString } from '@mdello/common/frontmatter';
import { load } from 'js-yaml';
import { companionPaths } from './xdg.ts';

export interface BoardRegistration {
  uuid: string;
  path: string;
  updatedAt: string;
}

interface CompanionConfig {
  boards: BoardRegistration[];
  herdrBundleId?: string;
}

export interface ResolvedCard {
  boardUuid: string;
  cardUuid: string;
  cardPath: string;
}

export async function readBoardUuid(boardPath: string): Promise<string> {
  const configPath = resolve(boardPath, 'mdello.yml');
  const data = load(await readFile(configPath, 'utf8'));
  const uuid =
    data && typeof data === 'object' ? readString(data as Frontmatter, 'uuid')?.trim() : undefined;
  if (!uuid) throw new Error(`Board config has no uuid: ${configPath}`);
  return uuid;
}

export async function listActiveCards(board: BoardRegistration): Promise<ResolvedCard[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(board.path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const cards = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => resolveCard(resolve(board.path, entry.name), [board])),
  );
  return cards.filter((card): card is ResolvedCard => card !== undefined);
}

export const DEFAULT_CONFIG_FILE = companionPaths().configFile;

function validBoard(value: unknown): value is BoardRegistration {
  if (!value || typeof value !== 'object') return false;
  const board = value as Partial<BoardRegistration>;
  return (
    typeof board.uuid === 'string' &&
    board.uuid.length > 0 &&
    typeof board.path === 'string' &&
    board.path.length > 0 &&
    typeof board.updatedAt === 'string'
  );
}

/** The whole config file, so callers reading one key never clobber another on save. */
async function loadConfig(configFile: string): Promise<Partial<CompanionConfig>> {
  try {
    const parsed = JSON.parse(await readFile(configFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Partial<CompanionConfig>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

export async function loadBoards(configFile = DEFAULT_CONFIG_FILE): Promise<BoardRegistration[]> {
  const config = await loadConfig(configFile);
  return Array.isArray(config.boards) ? config.boards.filter(validBoard) : [];
}

/** User-edited settings that live alongside board registrations in the same config file. */
export async function loadHerdrBundleId(
  configFile = DEFAULT_CONFIG_FILE,
): Promise<string | undefined> {
  const { herdrBundleId } = await loadConfig(configFile);
  return typeof herdrBundleId === 'string' && herdrBundleId.trim()
    ? herdrBundleId.trim()
    : undefined;
}

/** Preserves every other top-level key (e.g. herdrBundleId) instead of overwriting the file. */
async function saveBoards(configFile: string, boards: BoardRegistration[]): Promise<void> {
  const config = await loadConfig(configFile);
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify({ ...config, boards }, null, 2)}\n`);
}

export async function registerBoard(
  configFile: string,
  boards: BoardRegistration[],
  input: Pick<BoardRegistration, 'uuid' | 'path'>,
): Promise<BoardRegistration> {
  const uuid = input.uuid.trim();
  const path = resolve(input.path.trim());
  if (!uuid || !input.path.trim()) throw new Error('Board uuid and absolute path are required');

  const registration = { uuid, path, updatedAt: new Date().toISOString() };
  const retained = boards.filter((board) => board.uuid !== uuid && board.path !== path);
  boards.splice(0, boards.length, ...retained, registration);
  await saveBoards(configFile, boards);
  return registration;
}

/** A card is a direct child of its board folder, so at most one registration can own it. */
export function findBoardForPath(
  cardPath: string,
  boards: BoardRegistration[],
): BoardRegistration | undefined {
  const absolute = resolve(cardPath);
  return boards.find((board) => {
    const child = relative(board.path, absolute);
    return (
      child.length > 0 && !child.startsWith('..') && !child.includes('/') && !child.includes('\\')
    );
  });
}

export async function resolveCard(
  cardPath: string,
  boards: BoardRegistration[],
): Promise<ResolvedCard | undefined> {
  const absolute = resolve(cardPath);
  const board = findBoardForPath(absolute, boards);
  if (!board || !absolute.endsWith('.md')) return undefined;

  try {
    const { data } = parseFile(await readFile(absolute, 'utf8'));
    const cardUuid = readString(data, 'uuid')?.trim();
    if (!cardUuid) return undefined;
    return { boardUuid: board.uuid, cardUuid, cardPath: absolute };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
