// Core: diff lockfile texts, look up each changed version, run checks, apply allowlist.

import { parseLockfile, diffLockfiles, ecosystem } from './lockfile.js';
import { checkChange } from './checks.js';
import { fetchPackument, mapLimit } from './registry.js';

// lockfiles: [{ file, base, head }] (texts; base '' for a new lockfile)
export async function trustdiff(lockfiles, { getPackument = fetchPackument, allow = [], now = Date.now() } = {}) {
  const changes = lockfiles.flatMap(({ file, base, head }) =>
    diffLockfiles(parseLockfile(file, base), parseLockfile(file, head)).map((c) => ({ ...c, file, ecosystem: ecosystem(file) })));

  // Keyed by ecosystem too: `requests` on npm and on PyPI are different packages.
  const key = (c) => `${c.ecosystem}:${c.name}`;
  const byName = new Map();
  for (const c of changes) {
    const entry = byName.get(key(c)) ?? { name: c.name, ecosystem: c.ecosystem, versions: new Set(), full: false };
    [c.version, ...c.from].forEach((v) => entry.versions.add(v));
    entry.full ||= !c.from.length;
    byName.set(key(c), entry);
  }
  const packuments = new Map(await mapLimit([...byName], 8, async ([k, { name, ecosystem, versions, full }]) =>
    [k, await getPackument(name, [...versions], full, ecosystem)]));

  const results = changes.map((c) => ({ ...c, findings: checkChange(c, packuments.get(key(c)), now) }));
  const allowed = (r) => allow.includes(r.name) || allow.includes(`${r.name}@${r.version}`);
  return {
    changes: results.filter((r) => !allowed(r)),
    allowed: results.filter(allowed).length,
  };
}

// .trustdiff-allow: one `name` or `name@version` per line, `#` comments.
export function parseAllow(text) {
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}
