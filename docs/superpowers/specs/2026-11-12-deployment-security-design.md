# Deployment security and dependency modernization

## Goal and approved scope

Prepare the existing multiplayer and local-bot card game for Docker/VPS deployment. Upgrade direct dependencies to current stable releases, migrate breaking APIs, and preserve gameplay and the existing visual layout. Use a supported Node LTS runtime with matching type definitions. Refresh transitive dependencies and the committed npm lockfile. Remove unused dependencies only after verifying their usage.

The user selected Docker/VPS and approved full modernization plus hardening.

## Initial evidence

- `npm audit --json`: 31 affected packages (3 critical, 22 high, 6 moderate). Advisory applicability varies; this is a dependency inventory, not proof of exploitation.
- `npm outdated --json`: major migrations include Next, React, Chakra, Redis, Zustand, Vitest, ESLint, TypeScript, and internationalization packages. Resolve actual stable versions again during implementation.
- `npm run test:run`: all 52 bot-logic tests pass.
- `npx tsc --noEmit --incremental false`: fails in route exports/returns, undefined handling, and demonstration pages/stores.
- `npm run lint`: passes with warnings.
- `next.config.mjs` suppresses TypeScript and lint build failures.
- Action routes trust supplied player IDs without authentication; room hosting overwrites existing Redis keys; start-game lacks host authorization.
- Both API routes return full state, exposing unrevealed values and value-encoding card IDs.
- Redis read/modify/write is non-atomic; replacement removes the initial one-hour expiry. Chat history is unbounded.

## Architecture and trust boundaries

Keep guest play without account registration. Establish server-issued cryptographically random sessions using HttpOnly cookies, Secure in production and SameSite protection. Store session-to-player membership server-side, separately from public game state. Derive acting identity from the session; never authorize a client-supplied player ID. Protect mutation requests with same-origin checks appropriate to the configured public HTTPS origin.

Move game persistence and transitions out of Next route modules into server-only modules. Validate each action using a discriminated schema with bounded names, messages, identifiers, and request bodies. Reject unknown actions and malformed input before game mutation. Enforce membership, lobby/game/substage rules, host-only start, current-player turns, and legal reveal targets.

Represent physical cards internally with unpredictable opaque IDs unrelated to their value. Serialize a dedicated public state that omits values of hidden cards and any session secrets. Adapt the client to render card backs from public state and faces only when revealed. Keep local bot state independent of network sanitization.

Create rooms atomically without overwriting existing rooms. Execute state changes and settlement through bounded Redis optimistic transactions with retries, using isolated connections as required by the selected Redis client. Preserve or refresh a documented one-hour idle TTL on game updates. Ensure concurrent polling settles a round exactly once. Bound chat retention to 100 messages, player names to 40 characters, messages to 500 characters, and mutation payloads to 8 KiB. Implement Redis-backed rate limits for room creation, joins, actions, and polling, with explicit 429 responses and retry hints. Set initial limits above normal client polling/gameplay rates and test their boundaries.

Return consistent errors: 400 malformed input, 401 missing session, 403 forbidden action, 404 missing room, 409 state conflicts, 429 throttling, and generic 503 storage failures. Do not return raw Redis/internal errors. Use no-store responses for personalized game state. Add security headers compatible with Chakra/Emotion and Next; test browser behavior before enforcing a restrictive content policy.

## Dependency and compatibility migration

Resolve latest stable package versions from npm and inspect peer/runtime requirements. Upgrade Next and React together, migrate Chakra components/providers, update Zustand selectors as needed, migrate Redis connection/transaction APIs, and move linting to the supported ESLint CLI/configuration. Update TypeScript, tests, motion, internationalization, hooks, analytics, and remaining used packages. Preserve existing routes and repair demonstration-page types rather than silently discarding them.

Remove build-error suppression. Add an explicit typecheck script and deterministic CI installation. Any unresolved dependency advisory or peer incompatibility must be reported as a release limitation rather than hidden through forced installation or blanket overrides.

## English translation

The user requested English-only operation and explicitly asked to remove Chinese language support. Translate hard-coded Chinese UI, game rules, notifications, and remaining Chinese source comments and project specifications into natural English. Ensure the English resource covers every user-facing message. Remove the Chinese locale, language-switching UI and its references, and Chinese locale registration. Consolidate any unique information from the Chinese README into the English README, then remove the Chinese README and links to it. Maintain English deployment documentation. Preserve the meaning of game rules and technical specifications. Remove translation dependencies only if they become unused after simplifying the language infrastructure.

Verify English message coverage and smoke-test English home, lobby, multiplayer, local bot play, game rules, errors, and notifications. Check maintained source and documentation for remaining Chinese text and confirm that no Chinese option or language switcher remains.

## Docker/VPS delivery

Provide a multi-stage, non-root production image using Next standalone output and a supported Node LTS base. Add a Docker ignore file excluding Git metadata, local dependencies/build output, secrets, and development-only artifacts. Provide Compose services for the app and Redis; publish only the app on loopback by default and expose no Redis host port. Configure Redis authentication using deployment-provided environment values, persistent storage, health checks, and restart policies. Avoid baked-in secrets.

Document HTTPS termination through a reverse proxy, the trusted public origin, cookie requirements, environment setup, deployment/update commands, health checks, rollback, and Redis persistence/expiry behavior. Include a safe environment example and broaden secret-file ignore rules while retaining the example. Add an application readiness endpoint with bounded Redis checks and no secret disclosure.

## Verification and acceptance

- Fresh deterministic npm installation succeeds without forced peer resolution.
- All retained direct dependencies use verified current stable versions, with any necessary exception explicitly documented.
- Dependency audit has no unresolved high/critical findings; remaining findings, if any, are individually assessed and reported.
- Lint, explicit typecheck, all tests, and production build pass without suppression.
- Security regression tests cover forged identity, unauthorized start, malformed/oversized payloads, room collision, hidden-card disclosure (including IDs), rate limits, expiry, and concurrent mutation/settlement.
- Multiplayer smoke tests cover host/join/start/reveal/settlement/chat and session continuity; local bot play still works.
- Container build and Compose smoke tests cover readiness and gameplay when Docker is available. Missing tooling or infrastructure is recorded as unverified, never as a pass.
- CI runs installation, lint, typecheck, tests, build, and dependency auditing. Automated dependency-update configuration keeps future upgrades visible.

## Release boundary

This work prepares and verifies deployment artifacts. Production provisioning, DNS changes, and publishing a live deployment require deployment access and a separate explicit instruction. Security readiness is an evidence-based assessment, not a guarantee that the application is vulnerability-free.
