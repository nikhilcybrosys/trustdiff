// npm and PyPI lookups, returning packument-shaped { versions, time } objects for checks.js.
// npm uses the abbreviated packument for publish times, then the version document for publisher.

const REGISTRY = 'https://registry.npmjs.org';
const ATTEMPTS = 4; // first try plus three retries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, accept = 'application/json') {
  let wait = 0;
  let last = `registry request failed for ${url}`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (wait) await sleep(wait);
    let res;
    try {
      res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      last = `registry request failed for ${url}: ${err.message}`;
      wait = Math.min(500 * 2 ** attempt, 5_000);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    last = `registry returned ${res.status} for ${url}`;
    if (res.status !== 429 && res.status < 500) throw new Error(last);
    const retryAfter = Number(res.headers.get('retry-after'));
    wait = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5_000) : Math.min(500 * 2 ** attempt, 5_000);
  }
  throw new Error(last);
}

const path = (name) => name.replace('/', '%2F');

// versions: the new and base versions to compare. `full` is unused: the abbreviated packument
// already carries `time.created`. Abbreviated documents omit `_npmUser`, so each compared
// version is still fetched on its own for publisher and trusted-publishing.
export async function fetchPackument(name, versions, full, ecosystem = 'npm') {
  if (ecosystem === 'pypi') return fetchPypi(name);
  const doc = await getJson(`${REGISTRY}/${path(name)}`, 'application/vnd.npm.install-v1+json');
  if (!doc) return null;
  const packument = { versions: {}, time: doc.time ?? {} };
  await Promise.all(versions.map(async (v) => {
    const abbr = doc.versions?.[v];
    if (!abbr) return;
    const versionDoc = await getJson(`${REGISTRY}/${path(name)}/${v}`);
    packument.versions[v] = versionDoc
      ? { ...abbr, ...versionDoc, dist: { ...abbr.dist, ...versionDoc.dist } }
      : abbr;
  }));
  return packument;
}

// PyPI Simple JSON API (PEP 691): one request per project gives every file's upload time (PEP 700),
// provenance link (PEP 740) and yanked flag. Mapped into the packument fields checks.js reads:
// provenance = any file of the release has a PEP 740 attestation; "install script" = the release ships
// no wheel, so installing it runs build code. PyPI does not expose the uploader, so no publisher.
async function fetchPypi(name) {
  const doc = await getJson(`https://pypi.org/simple/${encodeURIComponent(name)}/`, 'application/vnd.pypi.simple.v1+json');
  if (!doc) return null;
  return pypiPackument(doc.files ?? []);
}

// files: Simple JSON API file entries. A version is yanked only when every file of that version is.
export function pypiPackument(files) {
  const packument = { versions: {}, time: {} };
  for (const f of files) {
    const version = pypiFileVersion(f.filename);
    if (!version) continue;
    const v = (packument.versions[version] ??= {
      dist: {},
      hasInstallScript: true,
      installScriptLabel: 'build code (sdist only, no wheel)',
      _files: 0,
      _yanked: 0,
    });
    v._files += 1;
    if (f.yanked) v._yanked += 1;
    if (f.provenance) v.dist.attestations = true;
    if (f.filename.endsWith('.whl')) v.hasInstallScript = false;
    const t = f['upload-time'];
    if (t && !(packument.time[version] <= t)) packument.time[version] = t;
    if (t && !(packument.time.created <= t)) packument.time.created = t;
  }
  for (const v of Object.values(packument.versions)) {
    v.yanked = v._files > 0 && v._yanked === v._files;
    delete v._files;
    delete v._yanked;
  }
  return packument;
}

// Wheel: name-version-tags.whl (name never contains '-'). sdist: name-version.tar.gz|.zip, where legacy
// names may contain '-' but PEP 440 versions do not. Other formats (egg, exe, msi) are ignored.
export function pypiFileVersion(filename) {
  if (filename.endsWith('.whl')) return filename.split('-')[1];
  const stem = /^(.+)\.(?:tar\.gz|zip|tar\.bz2|tgz)$/.exec(filename)?.[1];
  return stem ? stem.slice(stem.lastIndexOf('-') + 1) : null;
}

// Run fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
