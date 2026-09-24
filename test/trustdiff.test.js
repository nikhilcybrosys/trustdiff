import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseLockfile, diffLockfiles } from '../src/lockfile.js';
import { checkChange } from '../src/checks.js';
import { trustdiff, parseAllow } from '../src/trustdiff.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const OLD = '2025-01-01T00:00:00Z';
const pkg = (versions, time = {}) => ({ versions, time: { created: OLD, ...time } });
const checks = (findings) => findings.map((f) => `${f.level}:${f.check}`);

test('parses npm lockfile v3, including nested and scoped packages', () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'app' },
    'node_modules/a': { version: '1.0.0' },
    'node_modules/@s/b': { version: '2.0.0' },
    'node_modules/a/node_modules/@s/b': { version: '3.0.0' },
    'packages/local': { version: '0.0.0', link: true },
  } });
  const m = parseLockfile('package-lock.json', lock);
  assert.deepEqual([...m.get('a')], ['1.0.0']);
  assert.deepEqual([...m.get('@s/b')], ['2.0.0', '3.0.0']);
  assert.equal(m.size, 2);
});

test('rejects npm lockfile v1', () => {
  assert.throws(() => parseLockfile('package-lock.json', '{"lockfileVersion":1,"dependencies":{}}'), /v1/);
});

test('parses pnpm-lock v9 and v6 keys, ignoring importers and snapshots', () => {
  const v9 = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        version: 1.0.0\npackages:\n  a@1.0.0:\n    resolution: {integrity: x}\n  '@s/b@2.0.0':\n    resolution: {integrity: y}\nsnapshots:\n  c@9.9.9(react@18.0.0):\n    dependencies: {}\n`;
  const v6 = `lockfileVersion: '6.0'\npackages:\n  /a@1.0.0:\n    resolution: {integrity: x}\n  /@s/b@2.0.0(react@18.0.0):\n    dev: false\n`;
  for (const text of [v9, v6]) {
    const m = parseLockfile('pnpm-lock.yaml', text);
    assert.deepEqual([...m.keys()].sort(), ['@s/b', 'a']);
    assert.deepEqual([...m.get('@s/b')], ['2.0.0']);
  }
});

test('diff reports only versions new in head, with base versions as from', () => {
  const base = new Map([['a', new Set(['1.0.0'])], ['b', new Set(['1.0.0'])]]);
  const head = new Map([['a', new Set(['1.1.0'])], ['b', new Set(['1.0.0'])], ['c', new Set(['0.1.0'])]]);
  assert.deepEqual(diffLockfiles(base, head), [
    { name: 'a', version: '1.1.0', from: ['1.0.0'] },
    { name: 'c', version: '0.1.0', from: [] },
  ]);
});

test('unpublished version fails closed', () => {
  assert.deepEqual(checks(checkChange({ name: 'a', version: '2.0.0', from: [] }, pkg({}), NOW)), ['high:not-on-registry']);
  assert.deepEqual(checks(checkChange({ name: 'a', version: '2.0.0', from: [] }, null, NOW)), ['high:not-on-registry']);
});

test('provenance downgrade is high; keeping provenance is clean', () => {
  const tp = { name: 'GitHub Actions', trustedPublisher: { id: 'github' } };
  const p = pkg({ '1.0.0': { _npmUser: tp }, '1.0.1': { _npmUser: { name: 'GitHub Actions' } }, '1.0.2': { _npmUser: tp } }, { '1.0.0': OLD, '1.0.1': OLD, '1.0.2': OLD });
  assert.deepEqual(checks(checkChange({ name: 'a', version: '1.0.1', from: ['1.0.0'] }, p, NOW)), ['high:provenance-downgrade']);
  assert.deepEqual(checkChange({ name: 'a', version: '1.0.2', from: ['1.0.0'] }, p, NOW), []);
});

test('install scripts: added to existing package is high, on established new dep is warn', () => {
  const p = pkg({ '1.0.0': {}, '1.1.0': { scripts: { postinstall: 'node x' } } }, { '1.0.0': OLD, '1.1.0': OLD });
  assert.deepEqual(checks(checkChange({ name: 'a', version: '1.1.0', from: ['1.0.0'] }, p, NOW)), ['high:new-install-script']);
  assert.deepEqual(checks(checkChange({ name: 'a', version: '1.1.0', from: [] }, p, NOW)), ['warn:install-script']);
});

test('brand-new package with install script is high', () => {
  const created = '2026-05-31T12:00:00Z';
  const p = pkg({ '0.1.0': { hasInstallScript: true } }, { created, '0.1.0': created });
  assert.deepEqual(checks(checkChange({ name: 'x', version: '0.1.0', from: [] }, p, NOW)),
    ['high:install-script', 'warn:young-package', 'warn:young-version']);
});

test('publisher change is warn; compares against latest base version', () => {
  const p = pkg({ '1.0.0': { _npmUser: { name: 'old' } }, '1.1.0': { _npmUser: { name: 'alice' } }, '1.2.0': { _npmUser: { name: 'alice' } } },
    { '1.0.0': '2024-01-01T00:00:00Z', '1.1.0': '2025-01-01T00:00:00Z', '1.2.0': OLD });
  assert.deepEqual(checkChange({ name: 'a', version: '1.2.0', from: ['1.0.0', '1.1.0'] }, p, NOW), []);
  assert.deepEqual(checks(checkChange({ name: 'a', version: '1.2.0', from: ['1.0.0'] }, p, NOW)), ['warn:publisher-changed']);
});

test('allowlist suppresses by name or name@version', async () => {
  const lock = (v) => JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: v }, 'node_modules/@s/b': { version: v } } });
  const allow = parseAllow('# ok\na@2.0.0\n@s/b  # trusted\n');
  const r = await trustdiff([{ file: 'package-lock.json', base: lock('1.0.0'), head: lock('2.0.0') }],
    { allow, getPackument: async () => null, now: NOW });
  assert.equal(r.allowed, 2);
  assert.equal(r.changes.length, 0);
});

test('demo replays axios compromise and exits 1', () => {
  let out, status = 0;
  try {
    out = execFileSync('node', ['src/cli.js', 'demo'], { encoding: 'utf8' });
  } catch (e) {
    ({ stdout: out, status } = e);
  }
  assert.equal(status, 1);
  assert.match(out, /axios 1\.14\.0 → 1\.14\.1\n\s+high\s+provenance-downgrade/);
  assert.match(out, /plain-crypto-js \(new\) 4\.2\.1\n\s+high\s+install-script/);
});
