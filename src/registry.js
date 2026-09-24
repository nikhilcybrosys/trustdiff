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
export async function fetchPackument(name, versions, full) {
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
