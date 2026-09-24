// Parse lockfiles into Map<name, Set<version>> and diff two of them.

export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml'];

export function parseLockfile(file, text) {
  if (!text) return new Map();
  return file.endsWith('.yaml') ? parsePnpm(text) : parseNpm(text);
}

// npm lockfile v2/v3 ("packages" map). ponytail: v1 (npm 6) unsupported, npm 7+ has written v2+ since 2020.
function parseNpm(text) {
  const out = new Map();
  const { packages } = JSON.parse(text);
  if (!packages) throw new Error('package-lock.json v1 is not supported; run npm install with npm 7+');
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || entry.link || !entry.version) continue;
    add(out, entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 13), entry.version);
  }
  return out;
}

// pnpm-lock v6 (`/name@1.0.0:`) and v9 (`name@1.0.0:`) keys under `packages:`.
// ponytail: line regex instead of a YAML parser; enough for pnpm's fixed key format.
function parsePnpm(text) {
  const out = new Map();
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inPackages = line.startsWith('packages:');
    if (!inPackages) continue;
    const m = /^ {2}['"]?\/?((?:@[^@/\s]+\/)?[^@\s'"(]+)@([^\s'"(:]+)/.exec(line);
    if (m) add(out, m[1], m[2]);
  }
  return out;
}

function add(map, name, version) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(version);
}

// Versions present in head but not base. `from` = versions of the same package in base.
export function diffLockfiles(base, head) {
  const changes = [];
  for (const [name, versions] of head) {
    const before = base.get(name) ?? new Set();
    for (const version of versions) {
      if (!before.has(version)) changes.push({ name, version, from: [...before] });
    }
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}
