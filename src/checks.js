// Deterministic trust checks on one changed package version, using packument-shaped registry data
// (npm natively; registry.js maps PyPI into the same fields).

const DAY = 86_400_000;
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

const hasProvenance = (m) => Boolean(m.dist?.attestations || m._npmUser?.trustedPublisher);
const hasInstallScript = (m) => Boolean(m.hasInstallScript || INSTALL_HOOKS.some((h) => m.scripts?.[h]));
const publisher = (m) => m._npmUser?.name ?? null;
const installWhat = (m) => m.installScriptLabel ?? 'an install script';

// Returns [{ level: 'high'|'warn', check, message }]
export function checkChange({ name, version, from }, packument, now = Date.now()) {
  const v = packument?.versions?.[version];
  if (!v) {
    return [{ level: 'high', check: 'not-on-registry', message: `${version} is not on the registry (unpublished or never existed)` }];
  }
  const time = packument.time ?? {};
  // Compare against the most recently published base version still on the registry.
  const prevVersion = from
    .filter((f) => packument.versions[f])
    .sort((a, b) => Date.parse(time[b] ?? 0) - Date.parse(time[a] ?? 0))[0];
  const prev = prevVersion && packument.versions[prevVersion];
  const findings = [];
  const youngPackage = !from.length && time.created && now - Date.parse(time.created) < 7 * DAY;

  if (prev && hasProvenance(prev) && !hasProvenance(v)) {
    findings.push({ level: 'high', check: 'provenance-downgrade', message: `${prevVersion} was published with provenance/trusted publishing, ${version} was not` });
  }
  if (hasInstallScript(v) && !(prev && hasInstallScript(prev))) {
    findings.push(prev
      ? { level: 'high', check: 'new-install-script', message: `${version} adds ${installWhat(v)}; ${prevVersion} had none` }
      : youngPackage
        ? { level: 'high', check: 'install-script', message: `brand-new package runs ${installWhat(v)}` }
        : { level: 'warn', check: 'install-script', message: `new dependency runs ${installWhat(v)}` });
  }
  // Moving to trusted publishing changes the publisher name too; that is an upgrade, not a risk.
  if (prev && publisher(prev) !== publisher(v) && !hasProvenance(v)) {
    findings.push({ level: 'warn', check: 'publisher-changed', message: `publisher changed: ${publisher(prev) ?? 'unknown'} → ${publisher(v) ?? 'unknown'}` });
  }
  if (youngPackage) {
    findings.push({ level: 'warn', check: 'young-package', message: `new dependency; package first published ${age(now - Date.parse(time.created))} ago` });
  }
  if (time[version] && now - Date.parse(time[version]) < 2 * DAY) {
    findings.push({ level: 'warn', check: 'young-version', message: `${version} published ${age(now - Date.parse(time[version]))} ago` });
  }
  return findings;
}

function age(ms) {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
}
