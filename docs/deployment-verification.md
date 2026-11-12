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

### English-only conversion

Commits `2f79a29` and `16594c2` removed the Chinese locale, language selector, Chinese README, and i18next runtime dependencies. Maintained source, specifications, and primary documentation were translated to English. Verification at that checkpoint:

- Unicode Han scan: no matches in maintained `src`, `specs`, `README.md`, or `docs`.
- Bot suite: 52 of 52 tests passed.
- Scope review and code-quality review: passed after correcting the homepage repository link and restoring a literal rules translation.

The TypeScript failures from initial triage remained and are assigned to the framework modernization stage.

### Framework tooling compatibility

The application uses Next.js 16.4.6 with `output: "standalone"` for the Docker runtime image. ESLint is pinned to 9.39.5 rather than the newer 10.x release because the plugins bundled by `eslint-config-next` 16.4.6 cap their peer ranges at ESLint 9. Version 9.39.5 is therefore the latest compatible stable release; the lockfile is installed without peer overrides, `--force`, or `--legacy-peer-deps`.

TypeScript runs in the documented side-by-side transition configuration. The active `tsc` executable is TypeScript 7.0.2, provided by the `@typescript/native` npm alias. `require("typescript")` resolves through `@typescript/typescript6` 6.0.2 (whose compatibility API reports version 6.0.3) so ESLint and other tools that still require the TypeScript compiler API remain compatible. This arrangement is temporary until the lint toolchain supports the TypeScript 7 API, and the active compiler version is verified during release checks.

### Framework and dependency modernization

Commits `6cc5174`, `80b00a5`, and `82da0b9` upgraded every retained direct dependency to current stable and restored strict checks:

- Next.js 16.4.6, React/React-DOM 19.3.1, Chakra UI 3.38.0, Redis client 6.3.1, Zustand 5.1.0, TypeScript 7.0.2 (active `tsc`), Vitest 5.1.0, ESLint 9.39.5 (documented peer-compatible exception above).
- Node pinned to 26.13.1 LTS via `.nvmrc` and `engines`.
- Suppressed TypeScript and lint checking removed; `npm run lint` runs with `--max-warnings=0` and `npm run typecheck` runs `next typegen && tsc --noEmit` — both pass with zero warnings/errors.
- `npm outdated --json` returns no entries except the documented ESLint 9→10 compatibility exception.
- `npm ci` and `npm ls --all` complete cleanly with no invalid peers, force flags, or peer overrides.
- Migration regressions found by review (Chakra 3 gradient syntax, stale room-ID state on client-side query navigation, reset-timer cleanup, missing hook lifecycle tests) were fixed in `82da0b9`, adding a `useJoinRoomId` hook and expanding tests with `@testing-library/react` + `happy-dom`.
- Tests: 60 of 60 passed; lint, typecheck, and production build all pass under Node 26.13.1.

Audit at this checkpoint: 1 high and 8 moderate findings, all transitive/tooling (`typescript-eslint` chain, `lodash`, `minimatch`, `@babel/runtime`). Resolving or formally documenting the high finding remains a final-release blocker.

### Server sessions and request validation

Commits `4ca467f` and `7456ad3` added the first security layer under `src/lib/server/`, built test-first:

- Explicit discriminated action union (`host`, `join`, `start`, `reveal-public`, `reveal-player`, `chat`) with strict unknown-property rejection; legacy `playerId`/`data`/`gameId` client envelopes are rejected.
- Bounded identifier formats: rooms `[a-z0-9]{4,32}`, cards `1-12`/`[a-z]`, player IDs 32-char hex; names capped at 40 characters, chat messages at 500; C0 control characters rejected.
- Request bodies are read through a byte-counting stream reader capped at 8192 bytes regardless of `Content-Length`; client-abort read errors map to 400, malformed input to 400, and internal failures to a generic 503 with no internals leaked. All JSON responses carry `Cache-Control: no-store`.
- Sessions: server-generated 32-byte random token (base64url) plus a separate server-generated player ID; the store keys on the SHA-256 token digest; tokens never appear in JSON responses or stored records. Cookie is `HttpOnly; SameSite=Strict; Path=/`, `Secure` in production, TTL bounded to 7 days, sliding refresh, and valid sessions are reused for joins/hosting.
- Origin enforcement: production mutations require an `Origin` matching `APP_ORIGIN` exactly; cross-site fetch metadata is rejected; forwarded headers are ignored; a missing `APP_ORIGIN` in production fails closed.

Verification at that checkpoint: lint (zero warnings), typecheck, 121 of 121 tests, and production build all pass. Spec-compliance and code-quality reviews passed; the quality review's minor items (shared error constructor, TTL cap, control-character rejection, stream-abort mapping, chunk and cookie-parser test coverage) were fixed in `7456ad3`.

Not yet wired: the existing API routes still use the insecure legacy flow; route integration happens in stage 7, and Redis persistence hardening in stage 6. No production deployment has occurred.

### Game engine, permissions, and viewer-scoped projection

Commits `bc06195`, `dcf7531`, and `1552892` added the server-authoritative game engine and the public-state serializer:

- `src/lib/server/game-engine.ts` — pure transitions taking the authenticated player ID and an explicit timestamp. Membership, host-only start, lobby-only joins, 2–6 player limit, current-player turn gating, and legal unrevealed-target validation are enforced before any state change; rejected actions leave the state byte-identical (verified by mutation testing of the immutability assertions).
- Opaque card identity: deck cards receive 24-hex-character identifiers from `randomBytes(12)`, shuffled with cryptographic randomness. Min/max selection sorts by numeric value, never by identifier. Card-identifier validation in `src/lib/server/validation.ts` was updated to the opaque format (`/^[0-9a-f]{24}$/`); legacy value-bearing identifiers are rejected.
- Settlement: a mismatch or three matching reveals enters the settling substage; after the two-second window settlement runs once, collecting matching cards, detecting all four victory conditions, concealing the remainder, and advancing the turn. Any authenticated member's poll may drive an overdue settlement so a disconnected current player cannot stall the room.
- `src/lib/server/public-state.ts` — deny-by-default whitelist serializer producing `PublicCard` values (`{id, isRevealed:false}` or `{id, isRevealed:true, number}`). The viewer's own hand carries its own card numbers; every other hand stays concealed. Collected cards remain visible through conceal passes, removed cards leave stable empty slots, and session, token, digest, and deck fields are dropped even when injected into a fixture.
- Deliberate hardening divergences from the legacy routes are documented in code: start is accepted only from the lobby (so a finished room is not replayable), re-revealing a revealed public card is a conflict rather than a silent no-op, a member re-joining a full room succeeds as a no-op, and any member may drive settlement. The approved specification contains no rematch requirement, so the stricter lobby-only gate stands.

Verification at that checkpoint: lint (zero warnings), typecheck, 186 of 186 tests, and production build all pass. Spec-compliance and code-quality reviews passed; the review's findings (tautological immutability assertions, legacy card-identifier validation, viewer-invisible own hand, imprecise `min`/`max` typing, clone ordering, and two missing edge tests) were fixed in `dcf7531`, and the settlement stage guard is now pinned by a test in `1552892`.

Stage 6 (atomic Redis persistence, expiry, and throttling) and stage 7 (route and client integration) remain; the API routes still serve the legacy protocol until stage 7 replaces them.

### Runtime image preflight

Both official images were pulled successfully and their binaries executed:

- `node:26.13.1-bookworm-slim`: `node --version` returned `v26.13.1`; image digest `sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1`.
- `redis:8.10.3-alpine`: `redis-server --version` returned `8.10.3`; image digest `sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3`.

These are runtime preflight checks, not application-container verification.
