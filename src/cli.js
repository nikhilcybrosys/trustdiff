#!/usr/bin/env node
// trustdiff [base..head] [--json]   (head empty = working tree; default HEAD..)
// trustdiff demo                    replay of the March 2026 axios compromise, offline

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LOCKFILES } from './lockfile.js';
import { trustdiff, parseAllow } from './trustdiff.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });

if (values.help) {
  console.log('usage: trustdiff [base..head] [--json]\n       trustdiff demo\n\nExit: 0 ok, 1 high-risk finding, 2 error');
  process.exit(0);
}

try {
  const { range, lockfiles, opts } = positionals[0] === 'demo' ? demo() : fromGit(positionals[0] ?? 'HEAD..');
  if (!lockfiles.length) {
    console.log('trustdiff: no lockfile changes');
    process.exit(0);
  }
  const result = await trustdiff(lockfiles, opts);
  const high = result.changes.some((c) => c.findings.some((f) => f.level === 'high'));
  console.log(values.json ? JSON.stringify(result, null, 2) : report(range, result));
  process.exit(high ? 1 : 0);
} catch (err) {
  console.error(`trustdiff: ${err.message}`);
  process.exit(2);
}

function fromGit(range) {
  const [base, head = ''] = range.includes('..') ? range.split(/\.{2,3}/) : [range, ''];
  const show = (ref, file) => {
    try {
      return execFileSync('git', ['show', `${ref}:./${file}`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const read = (ref, file) => (ref ? show(ref, file) : existsSync(file) ? readFileSync(file, 'utf8') : '');
  // ponytail: root lockfiles only; add workspace/sub-directory lockfiles when monorepo users ask.
  const lockfiles = LOCKFILES.map((file) => ({ file, base: read(base || 'HEAD', file), head: read(head, file) }))
    .filter((l) => l.head && l.base !== l.head);
  const allow = existsSync('.trustdiff-allow') ? parseAllow(readFileSync('.trustdiff-allow', 'utf8')) : [];
  return { range, lockfiles, opts: { allow } };
}

function demo() {
  const dir = fileURLToPath(new URL('../fixtures/axios-2026-03/', import.meta.url));
  const read = (p) => readFileSync(dir + p, 'utf8');
  return {
    range: 'demo: axios 1.14.0 → 1.14.1 (2026-03-31, reconstructed)',
    lockfiles: [{ file: 'package-lock.json', base: read('base/package-lock.json'), head: read('head/package-lock.json') }],
    opts: {
      now: Date.parse('2026-03-31T01:00:00Z'),
      getPackument: async (name) => JSON.parse(read(`registry/${name.replace('/', '__')}.json`)),
    },
  };
}

function report(range, { changes, allowed }) {
  const flagged = changes.filter((c) => c.findings.length);
  const lines = [`trustdiff ${range}`, ''];
  for (const c of flagged) {
    const high = c.findings.some((f) => f.level === 'high');
    lines.push(`${high ? '✖' : '!'} ${c.name} ${c.from.length ? `${c.from.join(', ')} → ` : '(new) '}${c.version}`);
    for (const f of c.findings) lines.push(`    ${f.level.padEnd(4)}  ${f.check.padEnd(20)}  ${f.message}`);
  }
  const highCount = flagged.filter((c) => c.findings.some((f) => f.level === 'high')).length;
  if (flagged.length) lines.push('');
  lines.push(`${changes.length} changed, ${highCount} high-risk, ${flagged.length - highCount} warning, ${changes.length - flagged.length} clean${allowed ? `, ${allowed} allowed` : ''}`);
  return lines.join('\n');
}
