import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { claudeHookSettings, HOOK_PATH, isCompanionHook } from '@mdello/claude-extension';

const exec = promisify(execFile);
const SERVICE_LABEL = 'com.mdello.companion';

export type Integration = 'macos' | 'pi' | 'claude';

interface CommandResult {
  stdout: string;
}

interface InstallOptions {
  home?: string;
  platform?: NodeJS.Platform;
  repoRoot?: string;
  misePath?: string;
  uid?: number;
  /** Companion origin written into harness hook configuration. */
  endpoint?: string;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
}

function defaults(options: InstallOptions = {}) {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return {
    home: options.home ?? homedir(),
    platform: options.platform ?? process.platform,
    repoRoot,
    uid: options.uid ?? process.getuid?.() ?? 0,
    run: options.run ?? ((command: string, args: string[]) => exec(command, args)),
    misePath: options.misePath,
  };
}

async function pathKind(path: string): Promise<'missing' | 'symlink' | 'other'> {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'symlink' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function installMacOS(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  if (config.platform !== 'darwin') throw new Error('macOS installation requires macOS.');

  const misePath =
    config.misePath ?? (await config.run('sh', ['-lc', 'command -v mise'])).stdout.trim();
  if (!misePath) throw new Error('mise not found in PATH.');

  const templatePath = join(config.repoRoot, 'packages/companion/com.mdello.companion.plist');
  const destination = join(config.home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
  const temporary = `${destination}.tmp-${process.pid}`;
  const template = await readFile(templatePath, 'utf8');
  const plist = template
    .replaceAll('__MISE_BIN__', xmlEscape(misePath))
    .replaceAll('__MDELLO_ROOT__', xmlEscape(config.repoRoot))
    .replaceAll('__HOME__', xmlEscape(config.home));

  await mkdir(join(config.home, '.mdello'), { recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, plist);
  await rename(temporary, destination);

  const domain = `gui/${config.uid}`;
  try {
    await config.run('launchctl', ['bootout', domain, destination]);
  } catch {
    // Missing or unloaded services are already in the desired state.
  }
  await config.run('launchctl', ['bootstrap', domain, destination]);

  return `Installed and started ${destination}`;
}

export async function uninstallMacOS(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  if (config.platform !== 'darwin') throw new Error('macOS uninstallation requires macOS.');

  const destination = join(config.home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
  try {
    await config.run('launchctl', ['bootout', `gui/${config.uid}`, destination]);
  } catch {
    // Idempotent when service is absent or unloaded.
  }
  await rm(destination, { force: true });
  return `Removed ${destination}`;
}

function piPaths(home: string, repoRoot: string) {
  const extensions = join(home, '.pi/agent/extensions');
  return {
    // Pi resolves bare imports from the installed path, not the symlink target, so the
    // extension ships as a self-contained bundle instead of the workspace source tree.
    source: join(repoRoot, 'packages/pi-extension/dist/index.js'),
    destination: join(extensions, 'mdello-companion.js'),
    // Pre-bundle installs symlinked the package directory here.
    legacy: join(extensions, 'mdello-companion'),
  };
}

async function removeManagedSymlink(path: string, verb: string, label: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === 'other') throw new Error(`${verb} non-symlink ${label} at ${path}.`);
  if (kind === 'symlink') await rm(path);
}

export async function installPi(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const { source, destination, legacy } = piPaths(config.home, config.repoRoot);

  if ((await pathKind(source)) === 'missing') {
    throw new Error(`Missing Pi extension bundle at ${source}. Run \`yarn build:pi-extension\`.`);
  }

  await removeManagedSymlink(destination, 'Cannot replace', 'Pi extension');
  await removeManagedSymlink(legacy, 'Cannot replace', 'Pi extension');

  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination, 'file');
  return `Installed Pi extension ${destination} -> ${source}`;
}

export async function uninstallPi(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const { destination, legacy } = piPaths(config.home, config.repoRoot);

  await removeManagedSymlink(destination, 'Refusing to remove', 'Pi extension');
  await removeManagedSymlink(legacy, 'Refusing to remove', 'Pi extension');
  return `Removed Pi extension ${destination}`;
}

function claudeSettingsFile(home: string): string {
  return join(home, '.claude/settings.json');
}

function companionEndpoint(options: InstallOptions): string {
  if (options.endpoint) return options.endpoint;
  const port = process.env.MDELLO_COMPANION_PORT ?? '31337';
  return `http://127.0.0.1:${port}`;
}

async function readClaudeSettings(settingsFile: string): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(settingsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!contents.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Cannot parse ${settingsFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${settingsFile}.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Claude settings belong to the user, so reject anything unexpected instead of rewriting a shape
 * this installer does not understand.
 */
function readHookEvents(value: unknown, settingsFile: string): Record<string, unknown[]> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object at "hooks" in ${settingsFile}.`);
  }

  const events: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Expected an array at "hooks.${event}" in ${settingsFile}.`);
    }
    events[event] = entries;
  }
  return events;
}

/** Drop only this integration's hooks, leaving every other hook and its ordering untouched. */
function withoutCompanionHooks(events: Record<string, unknown[]>): Record<string, unknown[]> {
  const remaining: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(events)) {
    const kept = entries.flatMap((entry) => {
      const group = entry as { hooks?: unknown } | null;
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return [entry];
      const hooks = group.hooks.filter((hook) => !isCompanionHook(hook));
      if (hooks.length === group.hooks.length) return [entry];
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
    if (kept.length > 0) remaining[event] = kept;
  }
  return remaining;
}

async function writeClaudeSettings(
  settingsFile: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const temporary = `${settingsFile}.tmp-${process.pid}`;
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temporary, settingsFile);
}

/**
 * Claude Code enforces `allowedHttpHookUrls` only when the key exists, so add the companion
 * endpoint when the user opted into an allowlist and never create one for them.
 */
function withAllowedHookUrl(
  settings: Record<string, unknown>,
  endpoint: string,
  settingsFile: string,
): Record<string, unknown> {
  const allowed = settings.allowedHttpHookUrls;
  if (allowed === undefined) return settings;
  if (!Array.isArray(allowed)) {
    throw new Error(`Expected an array at "allowedHttpHookUrls" in ${settingsFile}.`);
  }

  const pattern = `${endpoint}/*`;
  return allowed.includes(pattern)
    ? settings
    : { ...settings, allowedHttpHookUrls: [...allowed, pattern] };
}

export async function installClaude(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const settingsFile = claudeSettingsFile(config.home);
  const endpoint = companionEndpoint(options);

  const settings = await readClaudeSettings(settingsFile);
  const events = withoutCompanionHooks(readHookEvents(settings.hooks, settingsFile));
  for (const [event, entries] of Object.entries(claudeHookSettings(endpoint))) {
    events[event] = [...(events[event] ?? []), ...entries];
  }
  await writeClaudeSettings(settingsFile, {
    ...withAllowedHookUrl(settings, endpoint, settingsFile),
    hooks: events,
  });

  return `Installed Claude hooks in ${settingsFile} -> ${endpoint}${HOOK_PATH}`;
}

export async function uninstallClaude(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const settingsFile = claudeSettingsFile(config.home);

  // Earlier installs symlinked a hook script; remove it so an upgrade leaves nothing behind.
  const legacyScript = join(config.home, '.claude/hooks/mdello-companion.js');
  await removeManagedSymlink(legacyScript, 'Refusing to remove', 'Claude hook');

  const settings = await readClaudeSettings(settingsFile);
  if (settings.hooks !== undefined) {
    const events = withoutCompanionHooks(readHookEvents(settings.hooks, settingsFile));
    await writeClaudeSettings(settingsFile, { ...settings, hooks: events });
  }

  return `Removed Claude hooks from ${settingsFile}`;
}

export async function installIntegrations(
  integration?: Integration,
  options: InstallOptions = {},
): Promise<string[]> {
  if (integration === 'macos') return [await installMacOS(options)];
  if (integration === 'pi') return [await installPi(options)];
  if (integration === 'claude') return [await installClaude(options)];

  const messages: string[] = [];
  if ((options.platform ?? process.platform) === 'darwin')
    messages.push(await installMacOS(options));
  messages.push(await installPi(options));
  messages.push(await installClaude(options));
  return messages;
}

export async function uninstallIntegrations(
  integration?: Integration,
  options: InstallOptions = {},
): Promise<string[]> {
  if (integration === 'macos') return [await uninstallMacOS(options)];
  if (integration === 'pi') return [await uninstallPi(options)];
  if (integration === 'claude') return [await uninstallClaude(options)];

  const messages: string[] = [];
  if ((options.platform ?? process.platform) === 'darwin') {
    messages.push(await uninstallMacOS(options));
  }
  messages.push(await uninstallPi(options));
  messages.push(await uninstallClaude(options));
  return messages;
}
