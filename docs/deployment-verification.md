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

Stage 7 (route and client integration) remains; the API routes still serve the legacy protocol until stage 7 replaces them.

### Atomic Redis persistence (stage 6, part A)

Commit `21f0c4b` replaced `src/lib/redis.ts` and added the atomic game store:

- The Redis client connects lazily through a single shared connection promise cached for hot reload, attaches an error listener, applies a finite reconnect policy (five attempts with backoff), and enforces a five-second connect timeout and command timeout. No connection is attempted at import or build time; the production build succeeds with `REDIS_URL` unset or pointing at an unreachable host. A missing URL raises a configuration error naming only the variable, and connection failures raise a generic unavailability error with the cause logged redacted.
- `createGame` uses `SET` with a not-exists condition and a one-hour expiry, mints room identifiers server-side with cryptographic randomness in the accepted format, retries collisions a bounded number of times, and never overwrites an existing room.
- `updateGame` watches the room key on an isolated connection, reads the state, applies the transition to a clone, and writes atomically with the expiry preserved; conflicts retry up to five times before a 409 is returned, and the connection is released with its watch cleared in a `finally` block. A transition that changes nothing skips the write, so polling neither rewrites state nor extends idle expiry. Settlement runs through the same path.
- Chat is trimmed to the newest 100 messages on every persist.
- Integration tests run against a disposable Redis instance keyed by a per-run prefix: concurrent joins lose no player, racing reveals and polls collect exactly once and advance the turn exactly once, room creation never overwrites, the expiry stays positive and is preserved across mutations, polling does not extend it, and chat is capped. Without `TEST_REDIS_URL` the suite is skipped with an explicit message; with it, 201 tests pass. A separate leak probe over 50 transactions showed the connected-client count rising only from one shared client to two including the administrative client.

### Redis limits, sessions, and final hardening (stage 6, part B)

Commits `2e1da0c`, `d49b05e`, `7a4e20c`, `e13bd54`, `9438ac0`, and `754c2a4` completed and hardened the Redis layer:

- Fixed-window rate limits use an atomic Lua counter with script caching and a tested `NOSCRIPT` recovery path. Budgets are 120 polls/minute, 120 actions/minute, 20 joins/minute, 10 hosts/hour, and a separate global unauthenticated creation cap of 60/minute. Keys are bounded, validated, and identity-hashed; forwarded client IPs are ignored unless an explicit trusted-proxy hop count is configured. Results expose the remaining budget and retry delay for stage 7 to emit 429 plus `Retry-After`.
- `RedisSessionStore` persists only SHA-256 token digests, enforces bounded logical and Redis TTLs, rejects and deletes stale or malformed records, checks player identifiers and timestamp chronology, and refreshes a valid session only through the explicit reuse/write path. Parity tests compare it with the in-memory session store.
- Atomic updates now allow one initial attempt plus five conflict retries, await synchronous or asynchronous transitions, and reject malformed transition results before writing. Persisted and returned states pass a closed runtime schema: room identity, stages, timestamps, players, cards, messages, allowed keys, and JSON-safe acyclic data are validated. Empty card identifiers are accepted only as concealed stable slots in `publicCards`, never in hands, collections, or the deck.
- Reads validate syntactically valid stored JSON through the same schema and map corrupt room documents to the generic storage failure. Repository prefixes, TTLs, and retry counts are bounded and validated.
- The shared Redis connection can recover after terminal reconnect exhaustion. Isolated WATCH connections have independent finite reconnect state so they cannot mark a healthy shared client terminal. Tests stop/restart a disposable Redis, kill one exact client connection, and verify recovery without leaking sockets.
- TTL tests use bounded condition polling rather than fixed sleeps; no-op updates and reads are proven not to refresh expiry.

Final stage-6 verification: lint with zero warnings, typecheck, production build, 233 unit/non-Redis tests passing with 46 integration tests explicitly skipped when `TEST_REDIS_URL` is absent, and 276 of 276 tests passing against disposable Redis 8.10.3. Spec and code-quality reviews passed with no remaining findings. No API or client route was changed in this stage.

#### Stage 7 wiring constraints identified during review

- A retried transition re-runs against the fresh state. For a player reveal that resolves to the player's minimum or maximum card, a retry can therefore reveal the next card instead of failing. The approved specification requires only `roomId`, `targetPlayerId`, and the min/max choice in the payload, so no concrete card identifier is mandated; the precondition must nevertheless be enforced in the engine, which is the only layer that observes the state committed inside the transaction, so the route layer cannot evaluate it atomically.
- The new repository and the legacy writer use the same `game:<roomId>` key space. The legacy writer drops the expiry and is not atomic, so stage 7 must retire the legacy routes in the same change that switches clients over.
- Room identifiers are now minted by the server. The client must navigate with the identifier returned by the host response instead of the client-generated one.
- Redis configuration and unavailability errors are not API errors and map to the generic 503 through the central error mapper without exposing the connection string.

### Secured API and multiplayer client integration (stage 7)

Commits `782d0fc`, `b3d7dd2`, `ebf4fe0`, and `19824a7` completed the route/client migration and its runtime hardening:

- Both API routes now delegate to the shared secure orchestration layer. Browser requests use only the strict action payloads and the server-issued session cookie; client-supplied identity is rejected. Host navigation uses the server-generated room ID, polling restores the authenticated viewer, and sanitized server errors plus retry delays reach the UI.
- Unauthenticated host and join requests consume the global bootstrap budget before session creation. A session created for a failed host/join attempt is deleted, while valid returning sessions bypass the bootstrap budget and retain their per-session limits.
- Multiplayer rendering consumes the viewer-scoped discriminated card projection. A viewer's own cards are represented as visible values, opponents remain concealed and numberless, and shared local-mode components use a separate display-only card interface. Opaque card IDs are never used to derive faces.
- Retried min/max reveals capture the concrete card precondition inside the repository transition closure without mutating the action object. A changed target fails rather than revealing a different card on retry.
- Chakra UI 3.38 documents an Emotion hydration defect under Next.js Turbopack with the exact observed `data-emotion="css-global"` mismatch. Commit `19824a7` applies Chakra's prescribed workaround by using `next dev --webpack` and `next build --webpack`; no hydration suppression was added. Next's generated `AGENTS.md` is tracked as requested by Next 16.4.6.

Fresh stage-7 verification after the final change:

- `npm run lint`: passed with zero warnings.
- `npm run typecheck`: passed after route type generation.
- `npm run test:run`: 249 passed, with 46 Redis integration tests explicitly skipped because `TEST_REDIS_URL` was absent.
- `TEST_REDIS_URL=redis://127.0.0.1:16379 npm run test:run`: 292 of 292 passed against disposable Redis 8.10.3.
- `npm run build`: the standalone Webpack production build completed successfully. Webpack emitted cache-serialization performance warnings only; TypeScript, compilation, static generation, and build tracing completed.
- A real HTTP smoke test with two isolated cookie jars passed host, join, start, poll, reveal, chat, and reload continuity; wrong-turn mutation returned 403, missing session 401, legacy identity spoofing 400, and foreign origin 403. Each viewer saw only their own hand values, hidden IDs were opaque, and response JSON contained no session material.
- A headless Chromium smoke test used two isolated browser contexts and asserted host-only Start controls, independent sessions, client navigation, and visible/hidden card rendering. It also started local bot mode and rendered `/deal-multi-player`, `/deal-poker`, `/flip-card`, `/switch-container`, and `/sounds`. The harness failed on any `Runtime.exceptionThrown` hydration message and completed with zero hydration errors. Screenshot: `/tmp/opencode/nana-browser-smoke.png`.

No public deployment was performed. Docker/VPS delivery remains stage 8.

### Runtime image preflight

Both official images were pulled successfully and their binaries executed:

- `node:26.13.1-bookworm-slim`: `node --version` returned `v26.13.1`; image digest `sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1`.
- `redis:8.10.3-alpine`: `redis-server --version` returned `8.10.3`; image digest `sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3`.

These are runtime preflight checks, not application-container verification.
