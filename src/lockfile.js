// Parse lockfiles into Map<name, Set<version>> and diff two of them.

export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock'];

export const ecosystem = (file) => (/(^|\/)(uv|poetry)\.lock$/.test(file) ? 'pypi' : 'npm');

export function parseLockfile(file, text) {
  if (!text) return new Map();
  if (ecosystem(file) === 'pypi') return parsePyLock(text, file.endsWith('uv.lock'));
  if (file.endsWith('yarn.lock')) return parseYarn(text);
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

// yarn berry (2+): `resolution: "name@npm:1.0.0"`; aliases resolve to the real name, and
// patch:/workspace:/git entries have no @npm: resolution so they drop out.
// yarn classic (v1): header `"name@range", "name@range2":` then `  version "1.0.0"`.
// `alias@npm:real@range` counts as `real`; git/file/url/github-shorthand ranges contain / or : and are skipped.
function parseYarn(text) {
  const out = new Map();
  if (/^__metadata:/m.test(text)) {
    for (const m of text.matchAll(/^ {2}resolution: "?((?:@[^@/\s]+\/)?[^@\s"]+)@npm:([^\s"]+?)"?$/gm)) add(out, m[1], m[2]);
    return out;
  }
  let name = null;
  for (const line of text.split('\n')) {
    if (/^[^\s#]/.test(line)) {
      const spec = line.replace(/:\s*$/, '').split(',')[0].trim().replace(/^"|"$/g, '');
      const m = /^((?:@[^@/]+\/)?[^@]+)@(?:npm:((?:@[^@/]+\/)?[^@]+)@)?(.*)$/.exec(spec);
      name = m && !/[/:]/.test(m[3]) ? (m[2] ?? m[1]) : null;
    } else if (name) {
      const v = /^ {2}version "?([^"\s]+)"?/.exec(line);
      if (v) {
        add(out, name, v[1]);
        name = null;
      }
    }
  }
  return out;
}

// uv.lock / poetry.lock: `[[package]]` blocks whose first top-level name/version keys are the package's.
// Only packages from pypi.org: uv marks them `source = { registry = "https://pypi.org/simple" }`, poetry
// marks everything else (git, path, url, private index) with a `[package.source]` table.
// ponytail: line regex instead of a TOML parser; both tools write these keys in a fixed format.
function parsePyLock(text, uv) {
  const out = new Map();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const fromPypi = uv
      ? /^source = \{ registry = "https:\/\/pypi\.org\/simple\/?" \}/m.test(block)
      : !/^\[package\.source\]/m.test(block);
    if (name && version && fromPypi) add(out, pypiName(name), version);
  }
  return out;
}

// PEP 503 normalized project name.
export const pypiName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

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
