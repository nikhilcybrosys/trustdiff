#!/usr/bin/env node
// trustdiff [base..head] [--json|--markdown]   (head empty = working tree; default HEAD..)
// trustdiff demo                    replay of the March 2026 axios compromise, offline

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LOCKFILES } from './lockfile.js';
import { trustdiff, parseAllow } from './trustdiff.js';
import { report, markdown } from './report.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' }, markdown: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });

  if (values.help) {
    console.log('usage: trustdiff [base..head] [--json|--markdown]\n       trustdiff demo\n\nExit: 0 ok, 1 high-risk finding, 2 error');
    process.exit(0);
  }

  try {
    const { range, lockfiles, opts } = positionals[0] === 'demo' ? demo() : fromGit(positionals[0] ?? 'HEAD..');
    if (!lockfiles.length) {
      if (values.json) console.log(JSON.stringify({ changes: [], allowed: 0 }));
      else console.log(values.markdown ? markdown('No lockfile changes.') : 'trustdiff: no lockfile changes');
      process.exit(0);
    }
    const result = await trustdiff(lockfiles, opts);
    const high = result.changes.some((c) => c.findings.some((f) => f.level === 'high'));
    console.log(values.json ? JSON.stringify(result, null, 2) : values.markdown ? markdown(`${high ? '✖ High-risk trust changes' : '✔ No high-risk trust changes'}\n\n\`\`\`\n${report(range, result)}\n\`\`\``) : report(range, result));
    process.exit(high ? 1 : 0);
  } catch (err) {
    console.error(`trustdiff: ${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function fromGit(range) {
  const [base, head = ''] = range.includes('..') ? range.split(/\.{2,3}/) : [range, ''];
  // An unresolvable ref would read as "no lockfile" and flag every dependency as new.
  for (const ref of [base, head].filter(Boolean)) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
    } catch {
      throw new Error(`unknown git ref '${ref}' (in CI, fetch it or use fetch-depth: 0)`);
    }
  }
  const show = (ref, file) => {
    try {
      return execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const read = (ref, file) => (ref ? show(ref, file) : existsSync(file) ? readFileSync(file, 'utf8') : '');
  const lockfiles = listChangedLockfiles(base, head)
    .map((file) => ({ file, base: read(base || 'HEAD', file), head: read(head, file) }))
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

const lockName = (file) => file.split('/').pop();

// Changed lockfiles between two commits, or between base and the working tree when head is empty.
export function listChangedLockfiles(base, head, cwd = process.cwd()) {
  const diff = execFileSync('git', ['diff', '--name-only', ...(head ? [base, head] : [base || 'HEAD'])], { cwd, encoding: 'utf8' });
  const paths = diff.split('\n').filter(Boolean);
  if (!head) {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
    paths.push(...untracked.split('\n').filter(Boolean));
  }
  return [...new Set(paths.filter((file) => LOCKFILES.includes(lockName(file))))];
}
