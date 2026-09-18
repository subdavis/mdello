import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type Association,
  type AssociationStatus,
  associationKey,
  isAssociationStatus,
} from '@mdello/common/associations';
import { type ActionContext, performAction } from './actions.ts';
import {
  type BoardRegistration,
  DEFAULT_CONFIG_FILE,
  listActiveCards,
  loadBoards,
  loadConfig,
  loadHerdrBundleId,
  loadWebOrigin,
  registerBoard,
  resolveCard,
} from './boards.ts';
import { createDebugLogger } from './debug.ts';
import { type ExtensionDependencies, startCompanionExtensions } from './extensions.ts';
import { HerdrSessionCache } from './herdr.ts';
import { findAdapter, harnessFromPath, hookAssociationInputs } from './hooks.ts';
import { companionPaths } from './xdg.ts';

export type { Association, AssociationStatus };
export { associationKey };

export interface CompanionOptions {
  host?: string;
  port?: number;
  dataFile?: string;
  configFile?: string;
  herdrPath?: string;
  herdrRun?: ActionContext['run'];
  extensionDependencies?: Omit<ExtensionDependencies, 'debug'>;
}

export interface ReconcileResult {
  associations: Map<string, Association>;
  purgedAssociations: number;
}

const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 51618;
export const DEFAULT_DATA_FILE = companionPaths().dataFile;
const MAX_BODY_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 250;
const debug = createDebugLogger();

/**
 * Whether a companion already holds the port. It keeps its associations in memory and rewrites the
 * whole log on reconciliation, so an offline command that edits the file must refuse to run.
 */
export function isCompanionListening(port: number, host = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ port, host });
    const settle = (listening: boolean) => {
      socket.destroy();
      resolveProbe(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function boardAssociations(
  associations: Map<string, Association>,
  boardUuid: string,
  cardUuid?: string,
): Association[] {
  return [...associations.values()].filter(
    (association) =>
      association.boardUuid === boardUuid && (!cardUuid || association.cardUuid === cardUuid),
  );
}

type PresentAssociations = (
  associations: Association[],
  ensureSessions?: boolean,
) => Promise<Association[]>;

interface AssociationContext {
  dataFile: string;
  associations: Map<string, Association>;
  clients: Map<ServerResponse, string>;
  boards: BoardRegistration[];
  presentAssociations: PresentAssociations;
}

async function writeBoardSnapshots(
  clients: Map<ServerResponse, string>,
  associations: Map<string, Association>,
  presentAssociations: PresentAssociations,
): Promise<void> {
  if (clients.size === 0) return;
  const presented = await presentAssociations([...associations.values()]);
  for (const [client, boardUuid] of clients) {
    writeSse(
      client,
      'snapshot',
      presented.filter((association) => association.boardUuid === boardUuid),
    );
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function parseOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isAllowedBrowserOrigin(origin: string, webOrigin: string): boolean {
  if (origin === webOrigin) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function browserSource(
  request: IncomingMessage,
): { header: 'Origin' | 'Referer'; value: string } | undefined {
  const origin = firstHeader(request.headers.origin);
  if (origin) return { header: 'Origin', value: origin };
  const referer = firstHeader(request.headers.referer);
  return referer ? { header: 'Referer', value: referer } : undefined;
}

function hasBrowserHeaders(request: IncomingMessage): boolean {
  return Boolean(
    request.headers.origin || request.headers.referer || request.headers['sec-fetch-site'],
  );
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'DELETE, GET, POST, OPTIONS');
  response.setHeader('Vary', 'Origin');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function rejectRequest(response: ServerResponse, error: string): void {
  sendJson(response, 403, { error });
}

function normalizeAssociation(value: unknown, legacyHarness?: string): Association | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Omit<Partial<Association>, 'status'> & { status?: string };
  const harness = candidate.harness ?? legacyHarness;
  let status = candidate.status;
  if (status === 'active') status = 'idle';
  if (status === 'inactive') status = 'closed';
  if (
    (candidate.boardUuid !== undefined && typeof candidate.boardUuid !== 'string') ||
    (candidate.cardUuid !== undefined && typeof candidate.cardUuid !== 'string') ||
    typeof candidate.cardPath !== 'string' ||
    !candidate.cardPath.startsWith('/') ||
    !candidate.cardPath.endsWith('.md') ||
    typeof harness !== 'string' ||
    !harness ||
    typeof candidate.sessionId !== 'string' ||
    !candidate.sessionId ||
    (candidate.sessionFile !== undefined && typeof candidate.sessionFile !== 'string') ||
    !isAssociationStatus(status) ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return undefined;
  }

  return {
    ...(candidate.boardUuid !== undefined && { boardUuid: candidate.boardUuid }),
    ...(candidate.cardUuid !== undefined && { cardUuid: candidate.cardUuid }),
    cardPath: candidate.cardPath,
    harness,
    sessionId: candidate.sessionId,
    ...(candidate.sessionFile !== undefined && { sessionFile: candidate.sessionFile }),
    status,
    updatedAt: candidate.updatedAt,
  };
}

async function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body too large');
  }
  return JSON.parse(body);
}

type AssociationInput = Partial<Association> & { markdownPath?: string };

/** Key-sorted so two records built from differently shaped inputs still compare equal. */
function associationFingerprint(association: Association): string {
  const { updatedAt: _timestamp, ...rest } = association;
  return JSON.stringify(Object.entries(rest).sort(([left], [right]) => left.localeCompare(right)));
}

/** Resolves one card, records it, and broadcasts it. Returns undefined for an unknown card. */
async function recordAssociation(
  input: AssociationInput,
  dataFile: string,
  associations: Map<string, Association>,
  clients: Map<ServerResponse, string>,
  boards: BoardRegistration[],
  presentAssociations: PresentAssociations,
): Promise<Association | 'unknown_card' | 'invalid'> {
  const requestedPath = input.markdownPath ?? input.cardPath;
  const card =
    typeof requestedPath === 'string' ? await resolveCard(requestedPath, boards) : undefined;
  if (!card) {
    debug('association ignored', { requestedPath, reason: 'unknown_card' });
    return 'unknown_card';
  }

  const association = normalizeAssociation(
    { ...input, ...card, updatedAt: new Date().toISOString() },
    'unknown',
  );
  if (!association) return 'invalid';

  // A harness that publishes per event may omit the session file on some of them; it belongs to
  // the session, so keep the last one we were told rather than dropping it.
  const key = associationKey(association);
  const previous = associations.get(key);
  if (!association.sessionFile && previous?.sessionFile) {
    association.sessionFile = previous.sessionFile;
  }

  // Both harnesses republish the current status on every prompt and every Markdown edit, and the
  // log is replayed last-write-wins. A record that moved only its timestamp therefore adds nothing
  // a client does not already hold, so keep the one we have instead of growing the log.
  if (previous && associationFingerprint(previous) === associationFingerprint(association)) {
    debug('association unchanged', {
      cardUuid: previous.cardUuid,
      harness: previous.harness,
      sessionId: previous.sessionId,
      status: previous.status,
    });
    return previous;
  }

  associations.set(key, association);
  await appendFile(dataFile, `${JSON.stringify(association)}\n`);
  debug('association recorded', {
    boardUuid: association.boardUuid,
    cardUuid: association.cardUuid,
    harness: association.harness,
    sessionId: association.sessionId,
    status: association.status,
  });
  const [presented] = await presentAssociations([association], true);
  for (const [client, boardUuid] of clients) {
    if (boardUuid === association.boardUuid) writeSse(client, 'association', presented);
  }
  return association;
}

async function handleAssociationPost(
  request: IncomingMessage,
  response: ServerResponse,
  dataFile: string,
  associations: Map<string, Association>,
  clients: Map<ServerResponse, string>,
  boards: BoardRegistration[],
  presentAssociations: PresentAssociations,
): Promise<void> {
  try {
    const input = (await readBody(request)) as AssociationInput;
    const result = await recordAssociation(
      input,
      dataFile,
      associations,
      clients,
      boards,
      presentAssociations,
    );
    if (result === 'unknown_card') {
      sendJson(response, 202, { ignored: true, reason: 'unknown_card' });
      return;
    }
    if (result === 'invalid') {
      sendJson(response, 400, { error: 'Invalid association' });
      return;
    }
    sendJson(response, 202, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('association request failed', { error: message });
    sendJson(response, 400, { error: message });
  }
}

const ACTION_ERROR_STATUS: Record<string, number> = {
  herdr_not_configured: 409,
  session_not_found: 404,
};

async function handleActionsPost(
  request: IncomingMessage,
  response: ServerResponse,
  actionContext: ActionContext,
): Promise<void> {
  try {
    const input = await readBody(request);
    const result = await performAction(input, actionContext);
    if (result === 'invalid') {
      sendJson(response, 400, { error: 'Invalid action' });
      return;
    }
    if (!result.ok) {
      sendJson(response, ACTION_ERROR_STATUS[result.error] ?? 500, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('action request failed', { error: message });
    sendJson(response, 400, { error: message });
  }
}

/**
 * Harness webhook endpoint. Agents that spawn a process per lifecycle event post the raw payload
 * here; the harness adapter translates it, so no agent-specific knowledge lives in the sidecar.
 *
 * Deliberately omits CORS headers: this route reads a caller-supplied session file, so it must not
 * be reachable from a browser page the way the board-facing routes are.
 */
async function handleHookPost(
  request: IncomingMessage,
  response: ServerResponse,
  harness: string,
  context: AssociationContext,
): Promise<void> {
  const { dataFile, associations, clients, boards, presentAssociations } = context;
  const adapter = findAdapter(harness);
  if (!adapter) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `Unknown harness: ${harness}` }));
    return;
  }

  // Withholding CORS headers only hides the response; the side effect would still run. Requiring
  // a JSON content type forces a preflight that this route rejects, so a browser page cannot
  // reach it at all. Both hook transports send this header.
  if (!request.headers['content-type']?.includes('application/json')) {
    debug('hook rejected', { harness, reason: 'content_type' });
    response.writeHead(415, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Expected application/json' }));
    return;
  }

  // A harness may parse this response and act on it — Claude Code errors on a non-JSON body — so
  // answer with an inert object whatever happens.
  const reply = (status: number) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end('{}');
  };

  try {
    const event = await adapter.translate(await readBody(request));
    if (!event) {
      debug('hook ignored', { harness });
      reply(202);
      return;
    }

    let recorded = 0;
    for (const input of hookAssociationInputs(event, harness, associations.values())) {
      const result = await recordAssociation(
        input,
        dataFile,
        associations,
        clients,
        boards,
        presentAssociations,
      );
      if (typeof result === 'object') recorded += 1;
    }
    debug('hook recorded', {
      harness,
      sessionId: event.sessionId,
      status: event.status,
      recorded,
    });
    reply(202);
  } catch (error) {
    debug('hook request failed', {
      harness,
      error: error instanceof Error ? error.message : String(error),
    });
    reply(400);
  }
}

export async function purgeAssociations(
  dataFile = process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE,
): Promise<void> {
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, '');
}

export async function saveAssociations(
  dataFile: string,
  associations: Iterable<Association>,
): Promise<void> {
  const entries = [...associations];
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(
    dataFile,
    entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '',
  );
}

export async function loadAssociationEvents(dataFile: string): Promise<Association[]> {
  const events: Association[] = [];
  try {
    const lines = createInterface({
      input: createReadStream(dataFile),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const association = normalizeAssociation(JSON.parse(line), 'unknown');
        if (association) events.push(association);
      } catch {
        // Ignore an incomplete final line after an interrupted append.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return events;
}

export async function loadAssociations(dataFile: string): Promise<Map<string, Association>> {
  const associations = new Map<string, Association>();
  for (const association of await loadAssociationEvents(dataFile)) {
    associations.set(associationKey(association), association);
  }
  return associations;
}

export async function expungeCardAssociations(
  dataFile: string,
  associations: Map<string, Association>,
  cardUuid: string,
): Promise<number> {
  const events = await loadAssociationEvents(dataFile);
  const remaining = events.filter((association) => association.cardUuid !== cardUuid);
  for (const [key, association] of associations) {
    if (association.cardUuid === cardUuid) associations.delete(key);
  }
  await saveAssociations(dataFile, remaining);
  return events.length - remaining.length;
}

export async function forgetSessionAssociations(
  dataFile: string,
  associations: Map<string, Association>,
  harness: string,
  sessionId: string,
  cardUuid?: string,
): Promise<number> {
  const matches = (association: Association) =>
    association.harness === harness &&
    association.sessionId === sessionId &&
    (!cardUuid || association.cardUuid === cardUuid);
  const events = await loadAssociationEvents(dataFile);
  const remaining = events.filter((association) => !matches(association));
  for (const [key, association] of associations) {
    if (matches(association)) associations.delete(key);
  }
  await saveAssociations(dataFile, remaining);
  return events.length - remaining.length;
}

export async function reconcileAssociations(
  dataFile: string,
  associations: Map<string, Association>,
  boards: BoardRegistration[],
): Promise<ReconcileResult> {
  const activeCards = (await Promise.all(boards.map((board) => listActiveCards(board)))).flat();
  const activeByUuid = new Map(activeCards.map((card) => [card.cardUuid, card]));
  const persistedEvents = await loadAssociationEvents(dataFile);
  const events = persistedEvents.length > 0 ? persistedEvents : [...associations.values()];
  const retainedEvents: Association[] = [];
  const reconciled = new Map<string, Association>();
  let changed = false;

  for (const association of events) {
    let identity = association.cardUuid ? activeByUuid.get(association.cardUuid) : undefined;
    identity ??= await resolveCard(association.cardPath, boards);
    if (!identity) {
      changed = true;
      continue;
    }

    const current = { ...association, ...identity };
    if (
      current.boardUuid !== association.boardUuid ||
      current.cardUuid !== association.cardUuid ||
      current.cardPath !== association.cardPath
    ) {
      changed = true;
    }
    retainedEvents.push(current);
    reconciled.set(associationKey(current), current);
  }

  if (changed) await saveAssociations(dataFile, retainedEvents);
  return {
    associations: reconciled,
    purgedAssociations: events.length - retainedEvents.length,
  };
}

async function handleAssociationDelete(
  response: ServerResponse,
  url: URL,
  dataFile: string,
  associations: Map<string, Association>,
  clients: Map<ServerResponse, string>,
  presentAssociations: PresentAssociations,
): Promise<void> {
  const cardUuid = url.searchParams.get('cardUuid');
  const harness = url.searchParams.get('harness');
  const sessionId = url.searchParams.get('sessionId');
  const hasPartialSessionSelector = Boolean(harness) !== Boolean(sessionId);
  if (hasPartialSessionSelector || (!cardUuid && !harness)) {
    sendJson(response, 400, { error: 'cardUuid or harness and sessionId are required' });
    return;
  }
  try {
    let removedEvents: number;
    if (harness && sessionId) {
      removedEvents = await forgetSessionAssociations(
        dataFile,
        associations,
        harness,
        sessionId,
        cardUuid ?? undefined,
      );
    } else if (cardUuid) {
      removedEvents = await expungeCardAssociations(dataFile, associations, cardUuid);
    } else {
      throw new Error('Invalid association selector');
    }
    await writeBoardSnapshots(clients, associations, presentAssociations);
    debug('associations expunged', { cardUuid, harness, sessionId, removedEvents });
    sendJson(response, 200, { removedEvents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('association expunge failed', { cardUuid, harness, sessionId, error: message });
    sendJson(response, 500, { error: message });
  }
}

async function handleEventsGet(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  associations: Map<string, Association>,
  context: {
    configFile: string;
    dataFile: string;
    boards: BoardRegistration[];
    clients: Map<ServerResponse, string>;
    presentAssociations: PresentAssociations;
    herdrCache: HerdrSessionCache;
  },
): Promise<Map<string, Association>> {
  const { configFile, dataFile, boards, clients, presentAssociations, herdrCache } = context;
  const boardUuid = url.searchParams.get('boardUuid');
  const boardPath = url.searchParams.get('boardPath');
  if (!boardUuid || !boardPath) {
    sendJson(response, 400, { error: 'boardUuid and boardPath are required' });
    return associations;
  }

  try {
    const registration = await registerBoard(configFile, boards, {
      uuid: boardUuid,
      path: boardPath,
    });
    const reconciled = await reconcileAssociations(dataFile, associations, boards);
    associations = reconciled.associations;
    await herdrCache.refresh([...associations.values()]);
    await writeBoardSnapshots(clients, associations, presentAssociations);
    debug('board registered', {
      boardUuid: registration.uuid,
      path: registration.path,
      purgedAssociations: reconciled.purgedAssociations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('board registration failed', { error: message });
    sendJson(response, 400, { error: message });
    return associations;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
  clients.set(response, boardUuid);
  const snapshot = await presentAssociations(boardAssociations(associations, boardUuid));
  writeSse(response, 'snapshot', snapshot);
  debug('event stream subscribed', { boardUuid, associations: snapshot.length });
  request.on('close', () => {
    clients.delete(response);
    debug('event stream unsubscribed', { boardUuid });
  });
  return associations;
}

async function handleEarlyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: AssociationContext,
): Promise<boolean> {
  if (request.method === 'OPTIONS') {
    // Refuse the preflight for harness hooks so no browser origin is ever granted access.
    if (harnessFromPath(url.pathname)) {
      response.writeHead(404);
      response.end();
      return true;
    }
    response.writeHead(204);
    response.end();
    return true;
  }

  if (request.method !== 'POST') return false;
  const harness = harnessFromPath(url.pathname);
  if (!harness) return false;
  await handleHookPost(request, response, harness, context);
  return true;
}

export async function createCompanionServer(options: CompanionOptions = {}): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const dataFile = options.dataFile ?? process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE;
  const configFile =
    options.configFile ?? process.env.MDELLO_COMPANION_CONFIG ?? DEFAULT_CONFIG_FILE;
  let associations = await loadAssociations(dataFile);
  const [config, boards] = await Promise.all([loadConfig(configFile), loadBoards(configFile)]);
  const herdrBundleId = await loadHerdrBundleId(configFile);
  const webOrigin = await loadWebOrigin(configFile);
  const herdrPath = options.herdrPath ?? process.env.HERDR_PATH;
  const actionContext: ActionContext = { herdrBundleId, herdrPath, run: options.herdrRun };
  const herdrCache = new HerdrSessionCache(actionContext);
  const presentAssociations: PresentAssociations = async (entries, ensureSessions = false) => {
    if (ensureSessions) await Promise.all(entries.map((entry) => herdrCache.ensure(entry)));
    return herdrCache.present(entries);
  };
  const herdrEnabled = Boolean(herdrBundleId && herdrPath);
  const clients = new Map<ServerResponse, string>();
  await mkdir(dirname(dataFile), { recursive: true });
  await open(dataFile, 'a').then((file) => file.close());

  const server = createServer(async (request, response) => {
    const requestHost = firstHeader(request.headers.host);
    let requestHostname: string | undefined;
    try {
      requestHostname = requestHost ? new URL(`http://${requestHost}`).hostname : undefined;
    } catch {
      requestHostname = undefined;
    }
    if (!requestHostname || !isLoopbackHostname(requestHostname)) {
      rejectRequest(
        response,
        `Host ${JSON.stringify(requestHost ?? '')} is not allowed. Connect to the companion through 127.0.0.1 or localhost.`,
      );
      return;
    }

    const url = new URL(request.url ?? '/', `http://${requestHost}`);
    debug('request received', { method: request.method, path: `${url.pathname}${url.search}` });

    const harness = harnessFromPath(url.pathname);
    if (harness && hasBrowserHeaders(request)) {
      rejectRequest(
        response,
        'Browser requests are not allowed for /hooks/*. These endpoints only accept local agent hook clients without Origin, Referer, or Sec-Fetch-Site headers.',
      );
      return;
    }

    if (!harness) {
      const source = browserSource(request);
      if (source) {
        const origin = parseOrigin(source.value);
        if (!origin || !isAllowedBrowserOrigin(origin, webOrigin)) {
          rejectRequest(
            response,
            `${source.header} ${JSON.stringify(source.value)} is not allowed. Set "webOrigin" in ${configFile} to this site's origin (for example, {"webOrigin":"https://example.com"}), then restart mdello-companion. Loopback origins are always allowed; current configured origin is ${JSON.stringify(webOrigin)}.`,
          );
          return;
        }
        if (request.headers.origin) setCors(response, origin);
      }
    }

    if (
      await handleEarlyRequest(request, response, url, {
        dataFile,
        associations,
        clients,
        boards,
        presentAssociations,
      })
    ) {
      return;
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      associations = await handleEventsGet(request, response, url, associations, {
        configFile,
        dataFile,
        boards,
        clients,
        presentAssociations,
        herdrCache,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/associations') {
      const boardUuid = url.searchParams.get('boardUuid');
      const cardUuid = url.searchParams.get('cardUuid') ?? undefined;
      const selected = boardUuid
        ? boardAssociations(associations, boardUuid, cardUuid)
        : [...associations.values()];
      sendJson(response, 200, await presentAssociations(selected));
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/associations') {
      await handleAssociationDelete(
        response,
        url,
        dataFile,
        associations,
        clients,
        presentAssociations,
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/associations') {
      await handleAssociationPost(
        request,
        response,
        dataFile,
        associations,
        clients,
        boards,
        presentAssociations,
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/settings') {
      sendJson(response, 200, { herdrEnabled });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/actions') {
      await handleActionsPost(request, response, actionContext);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const extensionJobs = await startCompanionExtensions(config, boards, {
    debug,
    ...options.extensionDependencies,
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  debug('server listening', { host, port: actualPort, boards: boards.length });
  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () => {
      extensionJobs.stop();
      return new Promise<void>((resolveClose, reject) => {
        for (const client of clients.keys()) client.end();
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}
