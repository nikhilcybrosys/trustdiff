import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseLockfile, diffLockfiles } from '../src/lockfile.js';
import { pypiFileVersion } from '../src/registry.js';
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

test('unknown git ref is an error, not "every dependency is new"', () => {
  let status = 0, stderr = '';
  try {
    execFileSync('node', ['src/cli.js', 'no-such-ref..HEAD'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    ({ status, stderr } = e);
  }
  assert.equal(status, 2);
  assert.match(stderr, /unknown git ref 'no-such-ref'/);
});

test('--markdown output carries the sticky-comment marker', () => {
  let out;
  try {
    out = execFileSync('node', ['src/cli.js', 'demo', '--markdown'], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout;
  }
  assert.ok(out.startsWith('<!-- trustdiff -->\n'));
  assert.match(out, /✖ High-risk trust changes/);
});

test('parses yarn classic: multi-range headers, scopes, aliases; skips git/file/github deps', () => {
  const v1 = `# yarn lockfile v1


"@babel/core@^7.0.0", "@babel/core@^7.1.0":
  version "7.22.0"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.22.0.tgz#abc"

lodash@^4.17.21:
  version "4.17.21"

"string-width-cjs@npm:string-width@^4.2.0":
  version "4.2.3"

"left-pad@git+https://github.com/x/left-pad.git#v1":
  version "1.3.0"

"local@file:./local":
  version "0.0.0"

"shorthand@user/repo":
  version "2.0.0"
`;
  const m = parseLockfile('yarn.lock', v1);
  assert.deepEqual([...m.keys()].sort(), ['@babel/core', 'lodash', 'string-width']);
  assert.deepEqual([...m.get('@babel/core')], ['7.22.0']);
  assert.deepEqual([...m.get('string-width')], ['4.2.3']);
});

test('parses yarn berry resolutions; skips workspace and patch entries', () => {
  const berry = `__metadata:
  version: 8
  cacheKey: 10c0

"@babel/core@npm:^7.0.0, @babel/core@npm:^7.1.0":
  version: 7.22.0
  resolution: "@babel/core@npm:7.22.0"

"string-width-cjs@npm:string-width@^4.2.0":
  version: 4.2.3
  resolution: "string-width@npm:4.2.3"

"resolve@patch:resolve@npm%3A^1.22.0#~builtin<compat/resolve>":
  version: 1.22.8
  resolution: "resolve@patch:resolve@npm%3A1.22.8#~builtin<compat/resolve>::version=1.22.8&hash=c3c19d"

"resolve@npm:^1.22.0":
  version: 1.22.8
  resolution: "resolve@npm:1.22.8"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
`;
  const m = parseLockfile('yarn.lock', berry);
  assert.deepEqual([...m.keys()].sort(), ['@babel/core', 'resolve', 'string-width']);
  assert.deepEqual([...m.get('resolve')], ['1.22.8']);
});

test('parses uv.lock: pypi.org packages only, names PEP 503-normalized', () => {
  const uv = `version = 1
requires-python = ">=3.10"

[[package]]
name = "Typing_Extensions"
version = "4.12.2"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "other" },
]

[[package]]
name = "private-lib"
version = "1.0.0"
source = { registry = "https://pkgs.example.com/simple" }

[[package]]
name = "docs"
version = "0.1.0"
source = { git = "https://github.com/x/docs#abc" }

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
`;
  const m = parseLockfile('uv.lock', uv);
  assert.deepEqual([...m.keys()], ['typing-extensions']);
  assert.deepEqual([...m.get('typing-extensions')], ['4.12.2']);
});

test('parses poetry.lock: skips packages with a [package.source] table', () => {
  const poetry = `[[package]]
name = "anyio"
version = "4.15.1"
optional = false

[package.dependencies]
idna = ">=2.8"

[[package]]
name = "internal"
version = "2.0.0"

[package.source]
type = "legacy"
url = "https://pkgs.example.com/simple"
reference = "private"

[metadata]
lock-version = "2.1"
`;
  const m = parseLockfile('poetry.lock', poetry);
  assert.deepEqual([...m.keys()], ['anyio']);
});

test('PyPI file names map to versions', () => {
  assert.equal(pypiFileVersion('annotated_doc-0.0.5-py3-none-any.whl'), '0.0.5');
  assert.equal(pypiFileVersion('python-dateutil-2.8.2.tar.gz'), '2.8.2');
  assert.equal(pypiFileVersion('pkg-1.0rc1.zip'), '1.0rc1');
  assert.equal(pypiFileVersion('pkg-1.0-py2.7.egg'), null);
});

test('same package name on npm and PyPI is looked up separately', async () => {
  const seen = [];
  const r = await trustdiff([
    { file: 'package-lock.json', base: '', head: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/requests': { version: '1.0.0' } } }) },
    { file: 'uv.lock', base: '', head: '[[package]]\nname = "requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\n' },
  ], { now: NOW, getPackument: async (name, versions, full, eco) => {
    seen.push(`${eco}:${name}:${versions}`);
    return pkg({ [versions[0]]: {} });
  } });
  assert.deepEqual(seen.sort(), ['npm:requests:1.0.0', 'pypi:requests:2.32.3']);
  assert.deepEqual(r.changes.map((c) => `${c.ecosystem}:${c.version}:${c.findings.length}`).sort(), ['npm:1.0.0:0', 'pypi:2.32.3:0']);
});
