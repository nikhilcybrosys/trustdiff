# trustdiff

**See what changed in *who you trust* when your lockfile changes.**

Dependabot tells you `axios 1.14.0 → 1.14.1`. It doesn't tell you that 1.14.0 was published by GitHub Actions with provenance and 1.14.1 was published from a stolen token, and that it added a brand-new dependency, created 19 hours earlier, that runs an install script.

That was the [axios compromise of March 2026](https://github.com/axios/axios/issues/10636). trustdiff flags it:

```
$ npx trustdiff demo
trustdiff demo: axios 1.14.0 → 1.14.1 (2026-03-31, reconstructed)

✖ axios 1.14.0 → 1.14.1
    high  provenance-downgrade  1.14.0 was published with provenance/trusted publishing, 1.14.1 was not
    warn  publisher-changed     publisher changed: GitHub Actions → RECONSTRUCTED-token-publish
    warn  young-version         1.14.1 published 38m ago
✖ plain-crypto-js (new) 4.2.1
    high  install-script        brand-new package runs an install script
    warn  young-package         new dependency; package first published 19h ago
    warn  young-version         4.2.1 published 1h ago

2 changed, 2 high-risk, 0 warning, 0 clean
```

## Usage

```sh
npx trustdiff                 # working tree vs HEAD
npx trustdiff main..HEAD      # a branch / PR
npx trustdiff main..HEAD --json
```

Exit codes: `0` no high-risk findings, `1` high-risk finding, `2` error.

It needs no account, no token and no install. It reads only public npm registry metadata.

## Checks

| Check | Level | Fires when |
|---|---|---|
| `not-on-registry` | high | The locked version is not on the registry (unpublished or never existed). Fails closed. |
| `provenance-downgrade` | high | The previous version had provenance or trusted publishing; the new one does not. |
| `new-install-script` | high | An existing package gains a `preinstall`/`install`/`postinstall` script. |
| `install-script` | high / warn | A new dependency runs an install script (high if the package is under 7 days old). |
| `publisher-changed` | warn | A different npm user published the new version. Not raised when moving *to* trusted publishing. |
| `young-package` | warn | A new dependency whose package was first published under 7 days ago. |
| `young-version` | warn | The new version was published under 48 hours ago. |

All checks are deterministic rules on registry metadata. No LLM, no heuristics score.

## Allowlist

Acknowledge a reviewed change in `.trustdiff-allow`:

```
# reviewed 2026-09-24: moved publishing to a new maintainer
some-package@2.0.0
@scope/pkg        # trust all versions
```

## Supported

- npm `package-lock.json` / `npm-shrinkwrap.json` (v2, v3)
- pnpm `pnpm-lock.yaml` (v6, v9)
- Lockfiles at the repository root

Not yet: yarn.lock, Python lockfiles, monorepo sub-directory lockfiles, a GitHub Action.

## About the demo fixture

The malicious axios 1.14.1 and plain-crypto-js versions were unpublished, so their registry documents no longer exist. `fixtures/axios-2026-03/` uses real axios 1.14.0 metadata and real publish times. The two malicious version documents are reconstructed from the public post-mortem and are marked `RECONSTRUCTED`.

## License

MIT
