import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export type AssociationStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'ready_for_review'
  | 'closed';

export interface Association {
  cardPath: string;
  harness: string;
  sessionId: string;
  sessionFile?: string;
  status: AssociationStatus;
  updatedAt: string;
}

export interface CompanionOptions {
  host?: string;
  port?: number;
  dataFile?: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 31337;
export const DEFAULT_DATA_FILE = resolve(homedir(), '.mdello', 'companion.jsonl');
const MAX_BODY_BYTES = 64 * 1024;

export function associationKey(
  association: Pick<Association, 'cardPath' | 'harness' | 'sessionId'>,
): string {
  return `${association.cardPath}\0${association.harness}\0${association.sessionId}`;
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setCors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  setCors(response);
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function normalizeAssociation(value: unknown, legacyHarness?: string): Association | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Association> & { status?: string };
  const harness = candidate.harness ?? legacyHarness;
  let status = candidate.status;
  if (status === 'active') status = 'idle';
  if (status === 'inactive') status = 'closed';
  if (
    typeof candidate.cardPath !== 'string' ||
    !candidate.cardPath.startsWith('/') ||
    !candidate.cardPath.endsWith('.md') ||
    typeof harness !== 'string' ||
    !harness ||
    typeof candidate.sessionId !== 'string' ||
    !candidate.sessionId ||
    (candidate.sessionFile !== undefined && typeof candidate.sessionFile !== 'string') ||
    (status !== 'idle' &&
      status !== 'running' &&
      status !== 'waiting_for_input' &&
      status !== 'ready_for_review' &&
      status !== 'closed') ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return undefined;
  }

  return { ...candidate, harness, status } as Association;
}

async function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body too large');
  }
  return JSON.parse(body);
}

async function handleAssociationPost(
  request: IncomingMessage,
  response: ServerResponse,
  dataFile: string,
  associations: Map<string, Association>,
  clients: Set<ServerResponse>,
): Promise<void> {
  try {
    const input = (await readBody(request)) as Partial<Association>;
    const association = normalizeAssociation(
      { ...input, updatedAt: new Date().toISOString() },
      'unknown',
    );
    if (!association) {
      sendJson(response, 400, { error: 'Invalid association' });
      return;
    }

    associations.set(associationKey(association), association);
    await appendFile(dataFile, `${JSON.stringify(association)}\n`);
    for (const client of clients) writeSse(client, 'association', association);
    sendJson(response, 202, association);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resetAssociations(
  dataFile = process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE,
): Promise<void> {
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, '');
}

export async function loadAssociations(dataFile: string): Promise<Map<string, Association>> {
  const associations = new Map<string, Association>();
  try {
    const lines = createInterface({
      input: createReadStream(dataFile),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const association = normalizeAssociation(JSON.parse(line), 'unknown');
        if (association) associations.set(associationKey(association), association);
      } catch {
        // Ignore an incomplete final line after an interrupted append.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return associations;
}

export async function createCompanionServer(options: CompanionOptions = {}): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const dataFile = options.dataFile ?? process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE;
  const associations = await loadAssociations(dataFile);
  const clients = new Set<ServerResponse>();
  await mkdir(dirname(dataFile), { recursive: true });
  await open(dataFile, 'a').then((file) => file.close());

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);

    if (request.method === 'OPTIONS') {
      setCors(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      setCors(response);
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      clients.add(response);
      writeSse(response, 'snapshot', [...associations.values()]);
      request.on('close', () => clients.delete(response));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/associations') {
      sendJson(response, 200, [...associations.values()]);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/associations') {
      await handleAssociationPost(request, response, dataFile, associations, clients);
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

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        for (const client of clients) client.end();
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
