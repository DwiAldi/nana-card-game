# Deployment verification

## Initial triage — 2026-11-12

The original checkout was not ready for public deployment:

- Dependency audit: 31 affected packages (3 critical, 22 high, 6 moderate), including production Next.js and development Vitest dependency chains. Package advisories need applicability assessment; counts do not establish exploitability.
- All 52 bot tests passed, but TypeScript checking failed. The build configuration suppressed TypeScript and lint errors.
- Multiplayer trusted client-supplied player identity and returned hidden card values and value-bearing card IDs.
- Hosting could overwrite rooms; game updates were non-atomic and removed expiry; chat history had no bound.

## Verified upgrade inputs

The npm registry was queried for each direct dependency's stable version, runtime requirements, and peers. Key available releases at triage were Next 16.4.6, React 19.3.1, Chakra UI 3.38.0, Redis client 6.3.1, Zustand 5.1.0, TypeScript 7.0.2, ESLint 10.14.0, and Vitest 5.1.0. The final lockfile and post-install checks determine the installed versions.

Node's official release index identifies **26.13.1 (Lithium)** as an LTS security release dated 2026-11-10. Its Linux x64 archive was downloaded from nodejs.org and verified against the published SHA-256 checksum for local verification. The original shell runtime was Node 22.16.0; release checks must use the selected LTS runtime explicitly.

Sources:

- <https://nodejs.org/dist/index.json>
- <https://nodejs.org/dist/v26.13.1/SHASUMS256.txt>
- <https://nextjs.org/docs/app/guides/upgrading/version-16>
- <https://chakra-ui.com/docs/get-started/migration>

## Release status

Implementation and release verification are in progress. No production deployment has been performed, and no readiness claim is made yet.

### Runtime image preflight

Both official images were pulled successfully and their binaries executed:

- `node:26.13.1-bookworm-slim`: `node --version` returned `v26.13.1`; image digest `sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1`.
- `redis:8.10.3-alpine`: `redis-server --version` returned `8.10.3`; image digest `sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3`.

These are runtime preflight checks, not application-container verification.
