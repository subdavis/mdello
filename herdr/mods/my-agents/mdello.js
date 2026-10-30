// Cards per herdr-core terminal, from the mdello companion's associations.
import { home, readTextFile } from "herdr";

const URL = "http://127.0.0.1:51618/associations";
export const STATE_DIR = `${home()}/.local/state/mdello`;

const cards = new Map(); // cardPath -> {title, tags}
const labels = new Map(); // board dir -> Map(tag -> color)
/** @type {any[]} */
let active = []; // live associations that name a terminal

const dirOf = (/** @type {string} */ p) => p.replace(/\/[^/]+$/, "");
const unquote = (/** @type {string} */ s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

// shortcut: line-based YAML for mdello's own output (scalars, flow or block string lists); use a YAML parser if hand-edited files break it.
/** @param {string} yaml @param {string} key */
function field(yaml, key) {
  return yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1];
}
/** @param {string} yaml @param {string} key */
function list(yaml, key) {
  const head = field(yaml, key);
  if (head === undefined) return [];
  if (head.trim().startsWith("[")) return head.trim().slice(1, -1).split(",").map(unquote).filter(Boolean);
  const block = yaml.match(new RegExp(`^${key}:.*\\n((?:[ \\t]+-.*\\n?)*)`, "m"))?.[1] ?? "";
  return [...block.matchAll(/^\s+-\s*(.+)$/gm)].map((m) => unquote(m[1]));
}

/** @param {string} dir */
async function boardLabels(dir) {
  if (!labels.has(dir)) {
    const yml = (await readTextFile(`${dir}/mdello.yml`)) ?? "";
    const section = yml.match(/^labels:\n((?:[ \t-].*\n?)*)/m)?.[1] ?? "";
    const map = new Map();
    for (const m of section.matchAll(/-\s*name:\s*(.+)\n\s+color:\s*(.+)/g)) map.set(unquote(m[1]), unquote(m[2]));
    labels.set(dir, map);
  }
  return labels.get(dir);
}

/** @param {string} path */
async function card(path) {
  if (!cards.has(path)) {
    const front = (await readTextFile(path))?.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const colors = await boardLabels(dirOf(path));
    const title = field(front, "title");
    cards.set(path, {
      title: title ? unquote(title) : path.split("/").pop().replace(/\.md$/, ""),
      tags: list(front, "tags").map((name) => ({ name, color: colors.get(name) })),
    });
  }
  return cards.get(path);
}

/** Refetches associations. Keeps the last list when the companion is unreachable. */
export async function refresh() {
  try {
    const res = await fetch(URL);
    if (!res.ok) return;
    active = /** @type {any[]} */ (await res.json()).filter((a) => a.status !== "closed" && a.hcTerminal);
  } catch (e) {
    console.log(`mdello: ${e}`);
  }
}

/** Map of terminal address -> [{title, tags: [{name, color?}]}]. */
export async function cardsByTerminal() {
  const out = new Map();
  for (const a of active) {
    const list = out.get(a.hcTerminal) ?? [];
    list.push(await card(a.cardPath));
    out.set(a.hcTerminal, list);
  }
  return out;
}

/** Folders holding bound cards: watchFolder takes folders, not files. */
export const boundDirs = () => new Set(active.map((a) => dirOf(a.cardPath)));

/** Drops cached bound cards (or a board's labels) that changed; true if any did. @param {string[]} paths */
export function forget(paths) {
  const bound = new Set(active.map((a) => a.cardPath));
  let hit = false;
  for (const p of paths) {
    if (p.endsWith("/mdello.yml") && labels.has(dirOf(p))) {
      labels.delete(dirOf(p));
      for (const c of cards.keys()) if (dirOf(c) === dirOf(p)) cards.delete(c);
      hit = true;
    } else if (bound.has(p)) {
      cards.delete(p);
      hit = true;
    }
  }
  return hit;
}

/** mdello's chip ink: white on dark swatches, board ink on light ones. @param {string} color */
export function textOn(color) {
  const lin = [1, 3, 5].map((o) => parseInt(color.slice(o, o + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.3 ? "#172b4d" : "#ffffff";
}
