// npm registry lookups, returning packument-shaped { versions, time } objects for checks.js.
// Full packuments are huge (typescript: 15 MB), so by default only the needed versions are fetched.

const REGISTRY = 'https://registry.npmjs.org';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${url}`);
  return res.json();
}

const path = (name) => name.replace('/', '%2F');

// versions: the new and base versions to compare. full: also need `time.created` (brand-new dependency).
export async function fetchPackument(name, versions, full, ecosystem = 'npm') {
  if (ecosystem === 'pypi') return fetchPypi(name);
  if (full) return getJson(`${REGISTRY}/${path(name)}`);
  const packument = { versions: {}, time: {} };
  await Promise.all(versions.map(async (v) => {
    const doc = await getJson(`${REGISTRY}/${path(name)}/${v}`);
    if (!doc) return;
    packument.versions[v] = doc;
    // ponytail: tarball Last-Modified tracks publish time within seconds; switch to the full packument if that ever drifts.
    const res = await fetch(doc.dist.tarball, { method: 'HEAD' });
    const modified = res.headers.get('last-modified');
    if (modified) packument.time[v] = new Date(modified).toISOString();
  }));
  return packument;
}

// PyPI Simple JSON API (PEP 691): one request per project gives every file's upload time (PEP 700),
// provenance link (PEP 740) and yanked flag. Mapped into the packument fields checks.js reads:
// provenance = any file of the release has a PEP 740 attestation; "install script" = the release ships
// no wheel, so installing it runs build code. PyPI does not expose the uploader, so no publisher.
async function fetchPypi(name) {
  const res = await fetch(`https://pypi.org/simple/${name}/`, { headers: { accept: 'application/vnd.pypi.simple.v1+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PyPI returned ${res.status} for ${name}`);
  const { files } = await res.json();
  const packument = { versions: {}, time: {} };
  for (const f of files) {
    const version = pypiFileVersion(f.filename);
    if (!version) continue;
    const v = (packument.versions[version] ??= { dist: {}, hasInstallScript: true, installScriptLabel: 'build code (sdist only, no wheel)' });
    if (f.provenance) v.dist.attestations = true;
    if (f.filename.endsWith('.whl')) v.hasInstallScript = false;
    const t = f['upload-time'];
    if (t && !(packument.time[version] <= t)) packument.time[version] = t;
    if (t && !(packument.time.created <= t)) packument.time.created = t;
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
