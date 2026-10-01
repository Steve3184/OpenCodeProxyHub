# Development Log

## 2026-10-01: System One Path Alias for NewAPI TypeSafe Channels

Status: complete

Context:

- NewAPI's TypeSafe channel adaptor (`relay/channel/typesafe/adaptor.go`) always forwards to `base_url + /zen/v1/systemone`.
- OpenCodeProxyHub only registered `POST /v1/systemone`, so `/zen/v1/systemone` returned `404 Route not found` while `/v1/systemone` worked.

Implemented:

- Registered `POST /zen/v1/systemone` as a route alias that shares the exact same handler as `POST /v1/systemone` (a real route, not a 301/302 redirect, so the POST body is preserved).
- Request logging now records the actual `request.url` so both paths are distinguishable in logs.
- Added `/zen/v1/systemone` to the `/health` endpoints list.
- Extended `scripts/systemone-routing-check.ts` to assert the alias is not a 404 and shares the canonical handler's status.

Verified:

- `npm run typecheck`, `npm run check:systemone`, `npm run check:tools`, `npm run check:responses` all pass.
- Live against real upstream: `POST /v1/systemone` and `POST /zen/v1/systemone` with `jev-1.13-free` return identical 200 bodies.

## 2026-05-20: Brand Display Normalization

Status: complete

Brand display standard:

- Product display name: `OpenCodeProxyHub`
- Short label: `OPH`
- Technical package/image identifiers remain lowercase kebab-case, for example `opencode-proxy-hub`.
- Do not rename Docker images, package names, local paths, Redis prefixes, or localStorage keys unless a migration is explicitly planned.

Implemented:

- Removed forced uppercase rendering from the main hero/login `h1` style so the UI displays `OpenCodeProxyHub` in mixed case.
- Updated the sidebar brand subtitle from `Proxy Hub` to `OpenCodeProxyHub`.

Verified:

- `npm run build:all` should be run after this change before deployment.

## 2026-05-20: API Key List Redesign

Status: complete

Implemented:

- Reworked API Key management from large stacked rows into a high-density list/table.
- Added a toolbar layout for new key name, create action, and search.
- Added table columns for:
  - status
  - name and labels
  - key prefix
  - request count
  - last used time
  - policy summary
  - recent client summary
  - actions
- Added enabled/disabled status pills, monospace key prefixes, compact policy summaries, and small row actions.
- Added responsive behavior: table header hides on narrower screens and rows become compact cards with field labels.

Verified:

- `npm run build:all` passes.
- Docker app image rebuilt successfully.
- `/app` returns 200 and app/Redis services are healthy.

Layout follow-up:

- Split Dashboard API Key content into a compact summary panel.
- Moved the full API Key table to the dedicated `API Keys` view only.
- Made the `API Keys` view panel full-width in the workspace.
- Added horizontal overflow protection and a minimum desktop table width so rows no longer exceed the panel background.
- Preserved responsive card behavior on narrower screens.

## 2026-05-21: Half-Width Browser Responsive Pass

Status: complete

Implemented:

- Added a dedicated `980px` breakpoint for desktop half-window and small-tablet layouts.
- At `980px` and below:
  - left rail becomes a top horizontal navigation bar
  - workspace uses normal page scrolling instead of fixed viewport scrolling
  - top status bar stacks vertically
  - hero panel is compressed and single-column
  - main grid becomes single-column
  - topology becomes vertical
  - `fullBleed` panels remove negative margins
  - API Key rows switch to card layout without horizontal table scrolling
  - proxy strategy cards, proxy form, proxy cards, monitor cards, and monitor columns become single-column
- Changed metric cards to `auto-fit` so they adapt across desktop, half-window, and mobile widths.
- Added overflow wrapping for long key prefixes, proxy URLs, proxy errors, and recent error text.

Verified:

- `npm run build:all` passes.
- Docker app image rebuilt successfully.
- `/app` returns 200 and app/Redis services are healthy.

## 2026-05-20: Frontend Redesign Plan

Status: complete

Design direction:

- Adopt an `Industrial Network Console` visual language for the Web UI.
- Position the product as an AI proxy gateway control center rather than a generic SaaS admin panel.
- Use a dark graphite/blue-black base, translucent panels, fine borders, subtle glow, network-grid texture, and clear status colors.
- Color roles:
  - green: healthy/success/available proxy
  - cyan: chain proxy/request route/upstream link
  - amber/orange: rate limit, 429 risk, warning
  - red: disabled, failed, critical error
  - gray: inactive or unavailable
- Keep Chinese UI text clear with system fonts; use monospace for numbers, API keys, URLs, and counters.

Target information architecture:

```text
1. Dashboard
2. API Keys
3. Models
4. Proxies
5. Observability
```

Recommended layout:

```text
Sidebar navigation + top status bar + main workspace
```

### Stage 1: Visual Framework Redesign

Goal: make `/app` feel like a finished operations console while preserving current behavior.

Scope:

- Rework global layout into sidebar, top status bar, and main workspace.
- Redesign login/unlock page around console access and service status.
- Create consistent base components:
  - button
  - input
  - select
  - panel
  - status badge
  - metric card
  - table/list row
- Add controlled atmosphere:
  - dark gradient background
  - subtle grid texture
  - chain/network line accents
  - restrained glow and hover states
- Maintain mobile usability.

Acceptance criteria:

- First impression is a professional AI gateway/network console.
- Existing features remain accessible.
- Desktop and mobile layouts are usable.
- Build passes.

### Stage 2: Dashboard Redesign

Goal: answer whether the gateway is currently usable at a glance.

Dashboard should surface:

- AI request count
- success/error rate
- upstream error rate
- active proxy count
- current outbound chain
- nodes at 429 risk
- Redis/local limiter state
- whether chained pre-proxy is enabled
- whether strict proxy mode (`REQUIRE_PROXY`) is enabled

Recommended chain card:

```text
Client -> OpenCodeProxyHub -> 7897 PreProxy -> Proxy Node -> opencode.ai
```

Acceptance criteria:

- User can see whether requests are currently proxied without opening proxy settings.
- 429 risk and unhealthy nodes are visible from the dashboard.

### Stage 3: Proxy Pool Redesign

Goal: make the proxy pool page the primary operations surface for sticky IP, chained proxy, and 429 handling.

Proxy node rows/cards should show:

- node name
- proxy type: `http`, `https`, `socks5`
- enabled/disabled status
- current strategy: priority fill
- daily request count and limit
- success/failure count
- consecutive 429 count: `x/5`
- current/max concurrency
- cooldown state
- last error
- last used time
- last checked time

Status color rules:

- green: healthy
- yellow: cooling down
- orange: 429 risk
- red: disabled or failed
- gray: inactive

Add a strategy summary section:

```text
Current strategy: priority fill
Auto-disable: after 5 consecutive upstream 429 responses
Fallback behavior: direct fallback disabled when REQUIRE_PROXY=true
```

Acceptance criteria:

- User can identify which node is being prioritized.
- User can see why a node is unavailable.
- Auto-disabled 429 nodes are visually obvious and explain that manual re-enable is required.

### Stage 4: API Key And Model Redesign

API Key page should emphasize client permissions and usage:

- key name
- key prefix
- enabled state
- request count
- recent clients
- allowed models
- proxy policy
- rate-limit policy
- recoverable secret copy when plaintext storage is enabled
- disable/delete actions

Model page should emphasize compatibility and routing:

- model ID
- upstream model behavior/name
- enabled state
- protocol compatibility notes
- remarks for problematic models such as special stream formats

Acceptance criteria:

- Key permissions and proxy behavior are understandable without opening raw JSON.
- Model availability and caveats are clear.

### Stage 5: Observability Redesign

Goal: support debugging and capacity testing.

Monitoring page should include:

- HTTP status distribution
- upstream status distribution
- P50/P95/P99 latency
- recent errors
- route heat
- proxy-node request/error distribution
- event stream for key operational events

Example event stream:

```text
15:41:09 proxy ok
15:42:10 upstream 429
15:42:11 node disabled after 5 consecutive 429
```

Acceptance criteria:

- Capacity tests can be interpreted from the UI.
- Proxy issues, upstream issues, and local limiter issues can be separated quickly.

Implementation recommendation:

- First implementation pass should cover Stage 1 + Stage 3.
- Keep API calls and backend contracts stable in the first pass.
- Focus first on `web/src/main.tsx` layout structure and `web/src/styles.css` visual system.
- Avoid over-animating; prioritize professional density, clear state, and operational readability.

Implementation pass completed:

- Reworked the app shell into a product sidebar, top status bar, hero status panel, metrics strip, and main workspace.
- Rebuilt the proxy pool surface around priority-fill operation:
  - strategy summary cards
  - current prioritized proxy
  - chained pre-proxy / strict proxy indicators
  - proxy node cards with status, counters, concurrency, weight, cooldown, and consecutive 429 progress
- Replaced the previous stylesheet with a darker industrial network console visual system.
- Verified `npm run build:all`.
- Rebuilt Docker app image and verified `/app` returns 200 with healthy app/Redis services.

Proxy pool visual follow-up:

- Added `recentResults` to proxy nodes and record the last 20 proxy request outcomes.
- Proxy cards now render a 20-segment request tape:
  - green: success
  - red: failure
  - gray: no sample yet
- Proxy page panel expands full-width in the workspace when the `Proxies` view is active.
- Added an explicit health status row to each proxy card.
- Verified `npm run build:all`, rebuilt Docker, checked `/app` returns 200, and confirmed a new proxy success sample is written to `recentResults`.

## 2026-05-20: Optional Chained Proxy MVP

Status: complete

Implemented:

- Added global outbound pre-proxy configuration:
  - `OUTBOUND_PRE_PROXY_ENABLED`
  - `OUTBOUND_PRE_PROXY_URL`
- Added `HttpPreProxyToSocksAgent` for this chain:

```text
OpenCodeProxyHub -> HTTP/HTTPS pre-proxy -> proxy-pool node -> upstream target
```

- Kept the default behavior unchanged when `OUTBOUND_PRE_PROXY_ENABLED=false`.
- Updated `.env.example`, `.env.docker.example`, `docker-compose.yml`, `README.md`, and `DEPLOYMENT.md`.

Verified:

- `npm run build:all` passes.
- Docker image rebuild passes.
- Temporary Docker test with `OUTBOUND_PRE_PROXY_ENABLED=true` and `OUTBOUND_PRE_PROXY_URL=http://host.docker.internal:7897` successfully tested a sealproxy SOCKS5 node through the pre-proxy against `https://opencode.ai/`.

Notes:

- Docker deployments should use `host.docker.internal` when the pre-proxy runs on the host machine.
- Chained mode now supports `http`, `https`, and `socks5` proxy-pool nodes.

Follow-up proxy routing update:

- Changed proxy node selection from least-concurrency/daily-count balancing to priority fill by weight/order.
- Added `consecutiveRateLimitCount` per proxy node.
- A proxy node is automatically disabled after 5 consecutive upstream 429 responses and must be manually re-enabled.
- Added `REQUIRE_PROXY` to prevent direct upstream fallback when no proxy node is available.

## 2026-05-20: Implementation Started

The project was created as an independent workspace at `G:\OpenCodeProxyHub`.

Initial direction:

- Backend: TypeScript + Fastify
- Frontend: React + Vite + Tailwind in a later phase
- Runtime state: Redis in a later phase
- Persistent storage: Postgres for production, SQLite acceptable during early development
- Deployment: Docker Compose first, scalable to multiple app instances behind Nginx/Caddy

### Phase 0: Project Boundary And Compliance

Status: complete

Deliverables:

- `LICENSE`
- `NOTICE`
- independent README
- source attribution to `opencode-free-proxy`

Completed:

- Added MIT `LICENSE`.
- Added `NOTICE` with source attribution.
- Added independent README and non-affiliation notice.

### Phase 1: Engineering Refactor

Status: complete for MVP baseline

Goals:

- Replace single-file JavaScript implementation with a maintainable TypeScript backend.
- Keep current behavior equivalent first.
- Add module boundaries for auth, routes, providers, converters, and sessions.

Initial target structure:

```text
src/
  main.ts
  app.ts
  config/env.ts
  routes/openai.ts
  routes/anthropic.ts
  routes/models.ts
  routes/health.ts
  auth/apiKeys.ts
  providers/zenClient.ts
  converters/anthropic.ts
  sessions/sessionStore.ts
  models/catalog.ts
  types/api.ts
```

Acceptance criteria:

- `GET /health` works.
- `GET /v1/models` works.
- `POST /v1/chat/completions` works for non-streaming and streaming requests.
- `POST /v1/messages` works for non-streaming and streaming requests.
- local API key behavior works during migration.

Notes:

- The initial TypeScript/Fastify module structure has been created.
- OpenAI and Anthropic compatible routes have been ported.
- `npm install` succeeded through the local proxy at `127.0.0.1:7897`.
- `npm run build` passes.
- `GET /health` and `GET /v1/models` were verified against the built service.

### Phase 2: Configuration And Persistent Storage

Status: complete for JSON-backed MVP

Implemented in this step:

- Added `JsonFileStore` storage abstraction.
- Upgraded API key persistence from plaintext `{name: key}` map to a versioned record file.
- Added SHA-256 API key hashing.
- Added `keyPrefix`, `enabled`, `createdAt`, and `lastUsedAt` metadata.
- Added automatic migration from the legacy plaintext key format.
- Kept first-run developer ergonomics by printing newly generated keys once at startup.
- Added admin API key management endpoints:
  - `GET /admin/api-keys`
  - `POST /admin/api-keys`
  - `PATCH /admin/api-keys/:id`
  - `DELETE /admin/api-keys/:id`
- Added `ADMIN_TOKEN` support for admin endpoints.
- During early development, when `ADMIN_TOKEN` is empty, any valid API key can access admin endpoints.
- Verified create/list/disable/delete admin API flow against the built service.
- Added JSON-backed model configuration in `models.json`.
- Added JSON-backed system settings in `settings.json`.
- Added admin model endpoints:
  - `GET /admin/models`
  - `PUT /admin/models/:id`
  - `DELETE /admin/models/:id`
- Added admin settings endpoints:
  - `GET /admin/settings`
  - `PATCH /admin/settings`
- Updated `/v1/models`, OpenAI route validation, Anthropic route validation, and `/health` to use persisted model configuration.
- Verified disabling and re-enabling a model updates the public model list.
- Verified settings update and restore through admin API.

Current storage format:

```json
{
  "version": 1,
  "keys": [
    {
      "id": "...",
      "name": "admin",
      "keyHash": "...",
      "keyPrefix": "oc-1234...abcd",
      "enabled": true,
      "createdAt": "...",
      "lastUsedAt": null
    }
  ]
}
```

Remaining future storage work:

- Replace JSON storage with SQLite/Postgres when moving beyond the local MVP.
- Add migration scripts when database-backed storage is introduced.

### Later Phases

- Phase 3: basic Web UI
- Phase 4: outbound proxy/IP pool
- Phase 5: Redis rate limiting and concurrency control
- Phase 6: high-concurrency multi-instance runtime
- Phase 7: logs, metrics, and monitoring
- Phase 8: API key fleet and multi-device controls
- Phase 9: protocol compatibility expansion
- Phase 10: load testing and stability
- Phase 11: production deployment

### Phase 3: Basic Web UI

Status: complete for Web UI MVP

Implemented:

- Added `web/` React + Vite + TypeScript project.
- Added industrial control-console visual direction with dark technical panels, topology cards, metrics, API key preview, model surface, and proxy-pool placeholder.
- Added `npm run dev:web`, `npm run build:web`, and `npm run build:all` scripts.
- Added backend static hosting for built Web UI under `/app`.
- Verified `npm run build:all` succeeds.
- Verified `/app`, `/app/`, and `/health` return 200 from the built service.

Update:

- Added admin token/dev key input with local storage persistence.
- Wired dashboard metrics to `/health`, `/v1/models`, and admin APIs.
- Wired API key list/create/enable/disable/delete to live admin APIs.
- Wired model enable/disable controls to live admin APIs.
- Wired settings controls to live admin APIs.
- Translated visible Web UI copy to Chinese while keeping technical terms such as API key, Fastify, Zen, and endpoint names.
- Verified `npm run build:all` succeeds.
- Verified `/app`, `/health`, and `/admin/api-keys` from the built service.
- Added side navigation with separate dashboard, API key, model, settings, and proxy-pool views.
- Added busy-state feedback and button disabling during operations.
- Added one-click copy for newly created API keys.
- Added better API key creation warning flow.
- Adjusted responsive/navigation styles for the new view model.

Remaining future Web UI work:

- Add true client-side routing if the UI grows beyond the current console shell.
- Add richer toast notifications.
- Add proxy-pool management screens in Phase 4.

### Phase 4: Outbound Proxy/IP Pool

Status: backend and Web UI MVP implemented, runtime verification pending after restarting the currently running old service

Goal:

- Add an outbound proxy pool for distributing upstream requests across multiple managed egress nodes.
- The proxy pool is for availability, pressure distribution, controlled routing, health checks, and quota enforcement.

Planned proxy node storage:

```json
{
  "id": "hk-1",
  "name": "香港节点 1",
  "type": "http",
  "url": "http://user:pass@1.2.3.4:8080",
  "enabled": true,
  "weight": 1,
  "maxConcurrency": 20,
  "dailyRequestLimit": 1000,
  "dailyRequestCount": 0,
  "dailyCountDate": "2026-05-20",
  "autoDisableWhenDailyLimitReached": true,
  "cooldownUntil": null,
  "successCount": 0,
  "failCount": 0,
  "lastError": null,
  "lastUsedAt": null,
  "lastCheckedAt": null
}
```

Required features:

- Support HTTP, HTTPS, and SOCKS5 proxy nodes.
- Add `proxies.json` for local MVP persistence.
- Add admin APIs to list, create, update, delete, enable, disable, and test proxy nodes.
- Add Web UI proxy-pool management screen.
- Track per-proxy request counts.
- Track per-proxy daily request counts.
- Add `dailyRequestLimit` for each proxy/IP.
- Automatically skip a proxy when its daily request count reaches the configured limit.
- Optionally auto-disable a proxy when `autoDisableWhenDailyLimitReached` is enabled.
- Reset daily counts by date rollover using `dailyCountDate`.
- Track per-proxy current concurrency.
- Enforce `maxConcurrency` per proxy.
- Record `lastUsedAt`, `lastError`, `successCount`, and `failCount`.
- Apply cooldown on timeout, connection failure, or upstream 429.

Initial scheduling strategy:

- Filter disabled nodes.
- Filter nodes in cooldown.
- Filter nodes whose daily limit is reached.
- Filter nodes whose current concurrency reached `maxConcurrency`.
- Select by least active connections first, then weight/round-robin.

Verification targets:

- A proxy with `dailyRequestLimit=1` is skipped after one successful attempt.
- A proxy can be manually re-enabled after auto-disable.
- Daily count resets when `dailyCountDate` changes.
- `/v1/chat/completions` can route through a selected proxy.
- Web UI shows request count, daily limit, enabled state, cooldown state, and last error.

Implemented so far:

- Added `proxies.json` local persistence.
- Added `ProxyPoolStore` with HTTP, HTTPS, and SOCKS5 proxy support.
- Added per-proxy daily request count and daily request limit.
- Added optional auto-disable when daily request limit is reached.
- Added date-based daily count reset.
- Added per-proxy current concurrency and `maxConcurrency` filtering.
- Added success/failure counters, `lastUsedAt`, `lastCheckedAt`, `lastError`, and cooldown fields.
- Added proxy selection filters for disabled, cooldown, daily limit, and max concurrency.
- Added `https-proxy-agent` and `socks-proxy-agent` dependencies.
- Wired Zen upstream requests to use a selected proxy agent when one is available.
- Added admin proxy APIs:
  - `GET /admin/proxies`
  - `POST /admin/proxies`
  - `PATCH /admin/proxies/:id`
  - `DELETE /admin/proxies/:id`
  - `POST /admin/proxies/:id/test`
- Added Web UI proxy management form.
- Added Web UI proxy list with enabled state, daily count/limit, concurrency, last error, test, enable/disable, and delete actions.
- `npm run build:all` passes.

Runtime verification note:

- Verification against port `6446` was blocked because an older manually started process is currently listening on that port (`PID 8328`).
- Stop and restart the service from the latest build before validating `/admin/proxies` endpoints.

Update:

- Restarted the service from the latest build and verified `/health`, `/app`, and `/admin/proxies` return 200.

### Phase 5: Local Rate Limiting And Concurrency Control

Status: complete for in-memory single-instance MVP

Implemented:

- Added local in-memory limiter with configurable request and concurrency controls.
- Added environment configuration:
  - `GLOBAL_REQUESTS_PER_MINUTE`
  - `API_KEY_REQUESTS_PER_MINUTE`
  - `API_KEY_MAX_CONCURRENT_REQUESTS`
  - `API_KEY_MAX_CONCURRENT_STREAMS`
- Switched request routing to authenticate API keys with stable key ids instead of display names.
- Wired `/v1/chat/completions` to enforce global RPM, per-API-key RPM, per-API-key concurrency, and per-API-key stream concurrency.
- Wired `/v1/messages` to enforce the same local limits for Anthropic-compatible requests.
- Added `Retry-After` on local 429 responses when the limiter can estimate the retry window.
- Ensured concurrency counters are released on response finish/close and on early validation failures.

Verification:

- `npm run build:all` passes.
- Restarted the service from the latest build.
- Verified `/health`, `/app`, and `/admin/proxies` return 200.
- Temporarily restarted with `API_KEY_REQUESTS_PER_MINUTE=1` and verified two local validation requests return 400 then 429, proving local API-key RPM enforcement without hitting the upstream Zen API.
- Restored the service with default limits after the rate-limit check.

Current running service:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after restore: `9824`

Remaining future rate-limit work:

- Replace in-memory limiter with Redis-backed counters for multi-instance deployment.
- Add admin/health visibility for limiter snapshots.
- Add Web UI controls for rate-limit settings.

### Phase 6: High-Concurrency Multi-Instance Runtime

Status: complete for Redis-backed limiter MVP with memory fallback

Goal:

- Move request rate and concurrency control from a single-process memory limiter toward a multi-instance runtime model.
- Keep local development simple when Redis is not configured.

Implemented:

- Added `redis` client dependency.
- Added `REDIS_URL` and `REDIS_KEY_PREFIX` configuration.
- Introduced a shared async limiter interface used by both memory and Redis backends.
- Kept `InMemoryLimiter` as the default fallback when `REDIS_URL` is empty.
- Added `RedisLimiter` using a Redis Lua script for atomic acquire decisions across instances.
- Redis-backed acquire enforces:
  - global requests per minute
  - per-API-key requests per minute
  - per-API-key concurrent requests
  - per-API-key concurrent streams
- Redis-backed release decrements request and stream concurrency counters when responses finish or close.
- Added limiter close hook during Fastify shutdown.
- Logged limiter backend snapshot during app startup.
- Updated OpenAI and Anthropic routes to use async limiter acquire/release.

Verification:

- `npm install redis` completed successfully.
- `npm run build:all` passes.
- Restarted the service from the latest build with default memory fallback.
- Verified `/health`, `/app`, and `/admin/proxies` return 200.
- Temporarily restarted with `API_KEY_REQUESTS_PER_MINUTE=1` and verified the async fallback limiter returns 400 then 429 for two local validation requests.
- Restored the service with default limits after the check.

Current running service:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after restore: `9784`

Remaining future high-concurrency work:

- Verify Redis limiter against a real Redis instance and multiple app processes.
- Move proxy-pool runtime counters to Redis or another shared store so proxy concurrency is coordinated across instances.
- Add graceful shutdown draining for in-flight upstream and streaming requests.
- Add limiter/proxy runtime metrics in Phase 7 monitoring.

Phase 6 closeout update:

- Added `RequestTracker` for local in-flight API request tracking.
- Added draining state so new OpenAI/Anthropic API requests can be rejected with 503 while the server is shutting down.
- Added `SHUTDOWN_DRAIN_TIMEOUT_MS` configuration, defaulting to 30000 ms.
- Fastify `onClose` now starts draining, waits for in-flight API requests to finish, logs timeout if requests remain, then closes the limiter backend.
- Added admin runtime visibility at `GET /admin/runtime`.
- Runtime response includes:
  - `runtime.draining`
  - `runtime.inFlightRequests`
  - `limiter` snapshot
- `npm run build:all` passes after closeout changes.
- Restarted the service from the latest build.
- Verified `/health`, `/app`, and `/admin/runtime` return 200.

Current running service after closeout:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after closeout restart: `37680`

Redis verification note:

- Redis-backed limiter code is implemented, but real multi-process verification requires a running Redis instance and at least two app processes configured with the same `REDIS_URL` and `REDIS_KEY_PREFIX`.
- That environment-level validation remains pending until Redis is available locally or in Docker.

### Phase 7: Logs, Metrics, And Monitoring

Status: complete for in-memory observability MVP

Goal:

- Add basic runtime visibility before production deployment work.
- Provide enough local monitoring to inspect request volume, status codes, latency, upstream errors, and recent failures from the admin console.

Implemented:

- Added `MetricsStore` in-memory observability collector.
- Added Fastify hooks to record HTTP request counts, status-code distribution, route distribution, latency percentiles, and recent server errors.
- Added upstream Zen request metrics for non-streaming and streaming paths:
  - total upstream requests
  - upstream status-code distribution
  - upstream latency percentiles
  - upstream error count and error rate
  - proxy id usage counts when a proxy node is selected
- Added admin metrics endpoint:
  - `GET /admin/metrics`
- Kept existing `GET /admin/runtime` as the runtime/limiter snapshot endpoint.
- Added Web UI monitoring navigation item and monitoring panel.
- Web UI monitoring panel now shows HTTP request totals, upstream request totals, error counts, P95 latency, runtime draining/in-flight state, limiter backend, uptime, route heat, status codes, and recent errors.

Verification:

- `npm run build:all` passes.
- Restarted the service from the latest build.
- Temporarily verified `/admin/metrics` and `/admin/runtime` with `ADMIN_TOKEN=dev-admin`.
- Restored the service with default startup behavior after the admin endpoint verification.
- Verified `/health` and `/app` return 200 after restore.

Current running service after Phase 7 MVP:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after restore: `23948`

Remaining future observability work:

- Add Prometheus/OpenMetrics export if external scraping is required.
- Add structured request log retention and search instead of only recent in-memory errors.
- Add persistent or external metrics storage for multi-instance deployments.
- Add alert rules for sustained 429/5xx rates, high latency, proxy cooldown spikes, and limiter saturation.

### Phase 8: API Key Fleet And Multi-Device Controls

Status: complete for API-key fleet and multi-device MVP

Clarified direction:

- This phase is not intended to become a multi-user SaaS tenant system.
- The target model is one gateway administrator managing many API keys.
- A single API key must be safe to use from many devices or clients at the same time.
- The system should prevent shared-key request collisions, session pollution, stuck concurrency counters, and unclear usage attribution.

Non-goals:

- No separate user-account system.
- No organization/tenant hierarchy.
- No RBAC role model beyond the existing admin control surface unless a concrete need appears later.

Planned scope:

- Improve API key fleet management:
  - support larger key lists with search/filter/pagination in the Web UI
  - add optional descriptions, labels, or usage notes per API key
  - support bulk enable/disable/delete if needed
- Add API-key-level policy overrides:
  - requests per minute
  - max concurrent requests
  - max concurrent streams
  - allowed model ids
  - optional proxy-pool access control
  - inherit global defaults when per-key settings are empty
- Make shared API key usage safer across many devices:
  - avoid deriving upstream session state only from the API key display name
  - prefer explicit client/session headers when provided, such as `x-session-id`, `x-client-id`, or `x-device-id`
  - otherwise derive a stable but collision-resistant session scope from API key id, protocol, and request context
  - ensure aborted streams and failed upstream requests always release limiter and request-tracker counters
- Add device/client observability without creating a user system:
  - record recent client identifiers by API key from `User-Agent`, `x-client-id`, or `x-device-id`
  - expose per-key recent usage, current concurrency, error counts, and last-used metadata in admin APIs and Web UI
- Keep Redis compatibility in mind:
  - per-key concurrency and RPM controls must continue to work with the existing Redis limiter backend
  - avoid local-only assumptions for counters that affect request admission

Initial acceptance criteria:

- Many API keys can be created and managed without the Web UI becoming hard to use.
- The same API key can be used concurrently from multiple clients without session cross-talk.
- Per-key policy overrides can restrict a noisy key without changing global defaults.
- Admin APIs and Web UI can show which keys are active, overloaded, error-prone, or recently used by multiple clients.

Implemented:

- Extended API key records with optional `description`, `labels`, `policy`, `requestCount`, and `recentClients` fields while preserving the existing JSON storage file shape.
- Added per-key policy overrides:
  - `requestsPerMinute`
  - `maxConcurrentRequests`
  - `maxConcurrentStreams`
  - `allowedModels`
  - `allowProxy`
- Updated the memory and Redis limiter interfaces so request admission can use per-key overrides while still inheriting global defaults when a key has no override.
- Added API-key-level model authorization after global model enablement checks.
- Added optional per-key proxy-pool access control through `allowProxy=false`.
- Added recent client observation per API key using `x-client-id`, `x-device-id`, and `User-Agent` without introducing user accounts or tenant concepts.
- Changed upstream session scope from API key display name to a multi-device-safe scope based on API key id, protocol, model, and explicit/client-derived session identifiers.
- Supported explicit client session isolation through `x-session-id`; otherwise falls back to `x-client-id`, `x-device-id`, or `User-Agent`.
- Expanded Web UI API Key management with search, request counts, notes/labels editing, policy editing, and recent-client display.

Verification:

- `npm run build:all` passes.
- Restarted the service from the latest build with temporary `ADMIN_TOKEN=dev-admin`.
- Verified `/health` and `/app` return 200.
- Verified `GET /admin/api-keys` returns the new policy, metadata, request count, and recent-client fields.
- Verified `PATCH /admin/api-keys/:id` can update per-key metadata and policy.
- Restored the test key metadata/policy after verification.
- Restored the service with default startup behavior and verified `/health` and `/app` return 200.

Current running service after Phase 8 MVP:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after restore: `348`

Remaining future API-key fleet work:

- Replace prompt-based Web UI policy editing with dedicated form controls.
- Add true pagination if API key count grows into hundreds or thousands.
- Add per-key daily/monthly quota windows if required.
- Add Redis/shared counters for richer per-key usage stats beyond limiter admission counters.

### Phase 9: Protocol Compatibility Expansion

Status: complete for protocol compatibility MVP

Goal:

- Improve compatibility with OpenAI-compatible and Anthropic-compatible clients without attempting to implement every edge case at once.
- Preserve existing gateway behavior while passing through common generation controls and improving repeatable compatibility checks.

Implemented:

- Extended OpenAI chat request typing and upstream passthrough for common fields:
  - `temperature`
  - `top_p`
  - `max_tokens`
  - `stop`
  - `presence_penalty`
  - `frequency_penalty`
  - `response_format`
  - `seed`
  - `user`
- Extended Anthropic message request typing and OpenAI-compatible conversion for common fields:
  - `max_tokens`
  - `temperature`
  - `top_p`
  - `stop_sequences` mapped to OpenAI `stop`
  - `tool_choice`
  - `metadata` accepted at the type boundary for client compatibility
- Extended Zen request preparation to accept a generic `parameters` payload and include defined fields in the upstream request body.
- Kept OpenAI `tools` and `tool_choice` passthrough.
- Kept Anthropic tool conversion from `tools`, `tool_use`, and `tool_result` into OpenAI-compatible tool call messages.
- Added upstream request cleanup for streaming paths when the downstream client connection closes.
- Added repeatable protocol smoke script:
  - `npm run smoke:protocol`
  - verifies OpenAI-compatible and Anthropic-compatible local error response shapes without requiring a live upstream call.

Verification:

- `npm run build:all` passes.
- Restarted the service from the latest build.
- Verified `/health` returns 200.
- Verified `/app` returns 200.
- Verified `npm run smoke:protocol` passes:
  - OpenAI invalid-auth response shape
  - Anthropic invalid-auth response shape

Current running service after Phase 9 MVP:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after restart: `27364`

Remaining future protocol work:

- Add live upstream compatibility checks when a disposable valid API key and network quota are available.
- Add structured fixtures for OpenAI non-streaming, OpenAI streaming, OpenAI tools, Anthropic non-streaming, Anthropic streaming, and Anthropic tools.
- Improve Anthropic streaming edge cases around multiple interleaved tool calls and text/tool block ordering.
- Normalize more upstream error variants into consistent OpenAI and Anthropic error envelopes.
- Consider dedicated automated tests around converter functions instead of only smoke scripts.

### Phase 10: Load Testing And Stability

Status: complete for local stability MVP

Goal:

- Add repeatable local pressure checks that do not consume upstream Zen quota.
- Close known stability gaps discovered during Phase 8 review before production deployment work.
- Verify runtime counters and metrics return to a healthy idle state after concurrent request load.

Implemented stability fixes:

- Admin fallback authentication no longer increments API key usage counters or `lastUsedAt`.
- API key runtime usage stats now use throttled persistence instead of writing the JSON key file on every authenticated request.
- Client usage observation still records recent clients, but also uses throttled stats persistence.
- Default session isolation was tightened: when no `x-session-id`, `x-client-id`, or `x-device-id` is provided, the gateway uses an anonymous per-request session scope instead of grouping clients by `User-Agent`.

Implemented verification scripts:

- Added `npm run smoke:load` using `scripts/load-smoke.mjs`.
- The load smoke test sends concurrent OpenAI-compatible and Anthropic-compatible invalid-auth requests to local validation paths, avoiding upstream calls and quota usage.
- Added `npm run check:stability` using `scripts/stability-check.mjs`.
- The stability check reads `/admin/runtime` and `/admin/metrics`, then verifies:
  - server is not draining
  - in-flight request count is zero
  - HTTP request metrics increased
  - status-code distribution is present

Verification:

- `npm run build:all` passes.
- Restarted the service from the latest build with temporary `ADMIN_TOKEN=dev-admin`.
- Verified `/health` returns 200.
- Verified `/app` returns 200.
- Verified `npm run smoke:protocol` passes.
- Verified `npm run smoke:load` passes with 80 requests at concurrency 16:
  - passed: 80
  - failed: 0
  - observed throughput: about 695 requests/second on local invalid-auth paths
- Verified `npm run check:stability` passes after the load smoke test.
- Stability check observed:
  - `runtime.draining=false`
  - `runtime.inFlightRequests=0`
  - limiter backend `memory`
  - HTTP metrics populated with 200/302/401 status distribution
- Restored the service with default startup behavior and verified `/health` and `/app` return 200.

Current running service after Phase 10 MVP:

- URL: `http://127.0.0.1:6446/app`
- Listening PID observed after restore: `31512`

Remaining future stability work:

- Add valid-key local limiter stress tests that avoid upstream calls by failing on validation after limiter acquisition.
- Add live upstream streaming interruption tests when quota and disposable keys are available.
- Add Redis-backed load testing with two or more app processes.
- Add memory growth tracking across longer soak tests.
- Add proxy-pool failure/cooldown stress tests with controlled bad proxy endpoints.

### Phase 11: Production Deployment

Status: complete for Docker deployment MVP

Goal:

- Provide a production-style Docker deployment path for the completed local MVP.
- Persist JSON-backed runtime state safely outside the container.
- Include Redis in the default Compose stack for multi-instance-ready limiter behavior.
- Document startup, health checks, smoke tests, backups, reverse proxy requirements, and upgrades.

Implemented:

- Added multi-stage `Dockerfile`:
  - installs backend and Web UI dependencies in a build stage
  - builds TypeScript backend and Vite Web UI
  - creates a smaller production runtime image
  - runs `node dist/main.js`
- Added `.dockerignore` to exclude local dependencies, build outputs, secrets, logs, and runtime JSON data.
- Added `docker-compose.yml` with:
  - `app` service
  - `redis` service
  - app healthcheck against `/health`
  - Redis healthcheck using `redis-cli ping`
  - host port `6446:6446`
  - bind mount `./data:/app/data`
  - named volume `redis-data`
  - container paths for `api-keys.json`, `models.json`, `settings.json`, and `proxies.json`
  - `REDIS_URL=redis://redis:6379`
- Added `.env.docker.example` production environment template.
- Updated `.gitignore` to ignore `.env.docker` and `data/`.
- Added `DEPLOYMENT.md` covering:
  - first start
  - Web UI access
  - persistent data files
  - backups
  - health checks
  - logs
  - smoke tests
  - reverse proxy notes
  - upgrade flow
  - security notes
- Updated `README.md` with Docker deployment entry point and deployment document link.

Verification:

- `npm run build:all` passes locally.
- `docker --version` is available locally.
- `docker compose config` passes and renders a valid Compose configuration.
- Initial `docker compose up -d --build` was blocked by Docker Hub timeout while resolving `node:22-slim` metadata.
- Switched the Docker base image to locally available `node:20-alpine`, which satisfies the project `node >=20` engine requirement.
- `docker compose up -d --build` completed successfully after the base image change.
- Docker Compose started both services:
  - `opencodeproxyhub-app-1`
  - `opencodeproxyhub-redis-1`
- `docker compose ps` reports both app and Redis healthy.
- Verified Docker-served `/health` returns 200.
- Verified Docker-served `/app` returns 200.
- Verified `npm run smoke:protocol` passes against the Docker stack.
- Verified `npm run smoke:load` passes against the Docker stack with 80 requests at concurrency 16:
  - passed: 80
  - failed: 0
  - observed throughput: about 666 requests/second on local invalid-auth paths
- Verified `npm run check:stability` passes against the Docker stack using the generated Docker development API key.
- Stability check observed:
  - `runtime.draining=false`
  - `runtime.inFlightRequests=0`
  - limiter backend `redis`
  - HTTP metrics populated
- Stopped the older local Node process that was also listening on host port `6446`, so host requests now reach the Docker-published service.

Current running Docker service after Phase 11 verification:

- URL: `http://127.0.0.1:6446/app`
- App container: `opencodeproxyhub-app-1`
- Redis container: `opencodeproxyhub-redis-1`
- Persistent JSON data directory: `./data`

Remaining production hardening work:

- Create `.env.docker` from `.env.docker.example` and set a strong `ADMIN_TOKEN` before exposing the service beyond local testing.
- Put HTTPS reverse proxy in front of the app for public access.
- Add image publishing/version tagging if deployments move beyond local Compose builds.

### Post-Phase 11 UX Improvement: Lightweight Console Login

Status: complete

Goal:

- Replace the confusing in-console token input with a dedicated login page.
- Avoid stale `localStorage` tokens causing unclear `Unauthorized` errors inside the already-rendered console.
- Keep the existing lightweight auth model: `ADMIN_TOKEN` when configured, otherwise development API key fallback.

Implemented:

- Added `GET /admin/session` for lightweight admin session validation.
- Session validation returns:
  - `authenticated=true`
  - `mode=admin-token` when `ADMIN_TOKEN` is used
  - `mode=api-key-fallback` when development API key fallback is used
- Web UI now starts in one of three states:
  - checking saved token
  - login page
  - authenticated management console
- Login page accepts management token or development API key.
- Successful login stores the token in `localStorage` and loads the management console.
- Failed login clears stale stored token and shows an explicit error.
- Management console header now shows auth mode and a logout button instead of a token input field.
- Admin API 401 responses clear the stored token and return the UI to the login page.

Verification:

- `npm run build:all` passes.
- Rebuilt and restarted Docker stack with `docker compose up -d --build`.
- Verified `GET /admin/session` returns 200 with the generated Docker development API key.
- Verified `GET /admin/session` returns 401 with an invalid token.
- Verified Docker-served `/app` returns 200 after rebuild.
- Verified `docker compose ps` reports app and Redis healthy.

### Post-Phase 11 UX Improvement: Dashboard AI Request Count

Status: complete

Goal:

- Make the dashboard headline metric represent actual AI API usage instead of all HTTP traffic.
- Avoid the confusing behavior where clicking refresh increases the dashboard request count.

Implemented:

- Changed the dashboard metric card from `请求总量` to `AI 请求数`.
- The Web UI now derives AI request count from route metrics:
  - `POST /v1/chat/completions`
  - `POST /v1/messages`
- The monitoring page still keeps the full HTTP request count, status distribution, and route heat map for operational debugging.

Verification:

- `npm run build:all` passes.
- Rebuilt and restarted Docker stack with `docker compose up -d --build`.
- Verified Docker-served `/app` returns 200.
- Verified `/admin/metrics` route stats are available.
- Verified current route stats contain only health/app routes after rebuild, so dashboard AI request count will remain 0 until actual AI API routes are called.
- Verified `docker compose ps` reports app and Redis healthy.

### Post-Phase 11 UX Improvement: Recoverable API Key Copy

Status: complete

Goal:

- Allow operators to copy API keys again from the Web UI when convenience is preferred over one-time plaintext display.
- Keep the behavior explicit and configurable because storing plaintext API keys increases secret-handling risk.

Implemented:

- Added `STORE_PLAINTEXT_API_KEYS` environment variable.
- Local `.env.example` defaults `STORE_PLAINTEXT_API_KEYS=false`.
- Docker `.env.docker.example` and `docker-compose.yml` enable `STORE_PLAINTEXT_API_KEYS=true` for operator convenience.
- API key records can now store `keyPlaintext` for newly created keys when plaintext recovery is enabled.
- Existing keys created before plaintext recovery was enabled remain non-recoverable.
- Public API key list now includes `hasRecoverableKey` so the UI can enable or disable copy actions.
- Added admin endpoint:
  - `GET /admin/api-keys/:id/secret`
- Web UI API Key row actions now include `复制 Key`.
- If a key has no recoverable plaintext, the copy action is disabled and the row indicates that it is a historical key without saved plaintext.
- Updated README and DEPLOYMENT security notes to explain that `api-keys.json` must be protected when plaintext recovery is enabled.

Verification:

- `npm run build:all` passes.
- Rebuilt and restarted Docker stack with `docker compose up -d --build`.
- Created a temporary API key under Docker with plaintext recovery enabled.
- Verified `GET /admin/api-keys/:id/secret` returns the same plaintext key as the create response.
- Verified the list response includes `hasRecoverableKey=true` for the temporary key.
- Deleted the temporary verification key after the check.
- Verified Docker-served `/app` returns 200.
- Verified `docker compose ps` reports app and Redis healthy.

### Post-Phase 11 Security/UX Improvement: Separate Console Password

Status: complete

Goal:

- Separate Web UI console login from API keys used by clients.
- Avoid the confusing behavior where deleting API keys can log the operator out of the console.
- Provide a simple initial password for local/private deployment.

Implemented:

- Added `ADMIN_PASSWORD` configuration.
- Default console password is `admin` when no environment variable is provided.
- `ADMIN_TOKEN` remains accepted as a migration fallback in configuration, but the runtime model is now `adminPassword`.
- Removed admin API key fallback from `/admin/*` authorization.
- API keys can no longer unlock or access the admin console.
- `GET /admin/session` now returns `mode=password`.
- Web UI login page now asks for `控制台密码` instead of management token/API key.
- Web UI logged-in state displays `控制台密码` as the login mode.
- Updated `.env.example`, `.env.docker.example`, `docker-compose.yml`, README, DEPLOYMENT, and stability-check script to use `ADMIN_PASSWORD`.

Verification:

- `npm run build:all` passes.
- Rebuilt and restarted Docker stack with `docker compose up -d --build`.
- Verified `GET /admin/session` returns 200 with password `admin`.
- Verified `GET /admin/session` returns 401 when using an API key as the admin credential.
- Verified Docker-served `/app` returns 200.
- Verified `docker compose ps` reports app and Redis healthy.
- Verified `npm run check:stability` passes with the default password.

Operational note:

- Change `ADMIN_PASSWORD` from `admin` before exposing the service beyond local/private testing.
- API keys are now only for OpenAI/Anthropic-compatible client requests, not console login.

## 2026-05-21: OpenAI Stream Protocol Normalization Plan

Status: planned

Context:

- Local testing showed `qwen3.6-plus-free` succeeds when called with `stream=true` but the upstream returns Anthropic-style SSE events through the OpenAI-compatible `/v1/chat/completions` route.
- The observed response shape is `event:message_start`, `event:content_block_delta`, `thinking_delta`, `text_delta`, and `message_stop` instead of OpenAI Chat Completions chunks.
- Standard OpenAI streaming clients expect `data: {"choices":[{"delta":...}]}` frames followed by `data: [DONE]`.
- Because the request is made to `/v1/chat/completions`, OPH should return OpenAI-compatible SSE regardless of the upstream provider-specific stream format.
- A comparison run against the upstream reference project `G:\opencode-free-proxy` showed the same passthrough behavior for `qwen3.6-plus-free`, so OPH needs an explicit compatibility improvement rather than only matching the reference implementation.

Goal:

- Add an independent Anthropic SSE to OpenAI Chat Completions SSE conversion feature for the OpenAI streaming endpoint.
- Enable the conversion only for an operator-managed whitelist of models.
- Preserve current passthrough behavior for models not in the whitelist.
- Support normal assistant text, reasoning/thinking deltas, and streaming tool calls.

Non-goals for the first implementation:

- Do not change `/v1/messages` Anthropic behavior.
- Do not globally auto-convert every OpenAI streaming response.
- Do not change non-streaming `/v1/chat/completions` behavior in the first pass.
- Do not attempt exact token accounting beyond forwarding usable usage metadata when available.
- Do not remove passthrough support for upstream responses that are already OpenAI-compatible.

Configuration design:

- Add a setting named `openAiStreamTransformModels` to the system settings file.
- Initial recommended value:

```json
{
  "version": 1,
  "settings": {
    "openAiStreamTransformModels": ["qwen3.6-plus-free"]
  }
}
```

- The setting means: when a client calls `/v1/chat/completions` with `stream=true` and the requested model is in this list, OPH converts Anthropic-style upstream SSE into OpenAI Chat Completions SSE.
- If the requested model is not listed, OPH keeps the existing streaming passthrough path.
- Future extension can replace the array with a transform map if multiple transform types are needed, for example `{ "qwen3.6-plus-free": "anthropic-sse-to-openai" }`.

Proposed code structure:

- Add a dedicated converter module:

```text
src/converters/anthropicSseToOpenAi.ts
```

- Keep the conversion logic separate from generic Zen transport code where practical.
- The OpenAI route or Zen streaming helper should select between:
  - existing passthrough pipe for normal models
  - new Anthropic SSE to OpenAI SSE pipe for whitelist models
- The route decision should be based on the original requested model ID, not the upstream's returned model alias.

Selection flow:

```text
POST /v1/chat/completions
  authenticate API key
  validate model
  validate model permissions
  prepare Zen request
  if stream=true and model in openAiStreamTransformModels
    pipe upstream through anthropicSseToOpenAi converter
  else
    use existing pipeZenOpenAIResponse passthrough
```

OpenAI SSE output contract:

- Response status should be `200` after a valid upstream stream starts.
- Response content type should be `text/event-stream`.
- Output frames should use OpenAI Chat Completions chunk format:

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1779360000,"model":"qwen3.6-plus-free","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1779360000,"model":"qwen3.6-plus-free","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1779360000,"model":"qwen3.6-plus-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Anthropic text and reasoning mapping:

- `message_start`:
  - initialize OpenAI stream state
  - emit one assistant role chunk with `delta.role = "assistant"`
- `content_block_delta` with `delta.type = "text_delta"`:
  - emit OpenAI chunk with `delta.content = delta.text`
- `content_block_delta` with `delta.type = "thinking_delta"`:
  - emit OpenAI-compatible reasoning chunk using `delta.reasoning_content = delta.thinking`
  - do not mix reasoning text into `delta.content`
- `signature_delta`:
  - ignore in the OpenAI stream
- `ping`:
  - ignore, or optionally send an SSE comment heartbeat if needed later

Tool calling mapping:

- On `content_block_start` where `content_block.type = "tool_use"`:
  - assign a stable OpenAI `tool_calls[].index`
  - store mapping from Anthropic `content_block.index` to OpenAI tool call index
  - emit an OpenAI tool call initialization chunk:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "id": "toolu_xxx",
            "type": "function",
            "function": {
              "name": "tool_name",
              "arguments": ""
            }
          }
        ]
      },
      "finish_reason": null
    }
  ]
}
```

- On `content_block_delta` where `delta.type = "input_json_delta"`:
  - find the mapped OpenAI tool call index for the current Anthropic block index
  - emit an OpenAI tool argument delta chunk:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "function": {
              "arguments": "partial json text"
            }
          }
        ]
      },
      "finish_reason": null
    }
  ]
}
```

- If `content_block_start` includes an initial `input` object, serialize it only if the upstream does not also send `input_json_delta`; otherwise prefer the streaming delta to avoid duplicated arguments.
- Multiple tool calls should be supported by maintaining a block-to-tool-index map and incrementing `nextToolIndex` for each new `tool_use` block.
- When Anthropic `message_delta.stop_reason` indicates `tool_use`, finish with OpenAI `finish_reason = "tool_calls"`.

Finish reason mapping:

- `end_turn` -> `stop`
- `tool_use` -> `tool_calls`
- `max_tokens` -> `length`
- missing or unknown stop reason -> `stop`
- On `message_stop`, emit the final OpenAI chunk and `data: [DONE]` exactly once.

Error handling:

- If the first upstream payload is a JSON error object, return an OpenAI-style error response when headers have not been sent.
- If upstream emits an Anthropic error event before any OpenAI chunk has been sent, map it to an OpenAI-style error response.
- If upstream fails after stream headers or chunks have been sent, end the stream with best-effort `[DONE]` only when safe; otherwise close the connection and record metrics.
- Preserve existing timeout and proxy failure tracking behavior.
- Continue recording upstream status and latency in metrics.

Parser design:

- Maintain a text buffer across upstream chunks.
- Parse SSE by event blocks separated by blank lines.
- For each block, collect:
  - optional `event:` value
  - one or more `data:` lines joined with newlines
- Ignore empty blocks.
- Parse JSON data when possible.
- Treat non-JSON `data: [DONE]` as a stream terminator.
- Avoid assuming each upstream TCP chunk contains a complete SSE event.

Runtime state design:

```ts
interface TransformState {
  id: string;
  created: number;
  model: string;
  roleSent: boolean;
  blockToToolIndex: Map<number, number>;
  nextToolIndex: number;
  sawToolCall: boolean;
  stopReason: "stop" | "tool_calls" | "length";
  doneSent: boolean;
}
```

Compatibility notes:

- Some clients ignore non-standard `reasoning_content`; this is acceptable because final text still arrives through `delta.content`.
- Clients that support DeepSeek/R1-style reasoning can display `reasoning_content`.
- The converter should not emit Anthropic `event:` names on the OpenAI endpoint.
- The converter should always emit OpenAI `data:` frames and a terminal `data: [DONE]`.

Testing plan:

- Manual streaming test for `qwen3.6-plus-free` through `/v1/chat/completions` should return OpenAI-style SSE chunks rather than Anthropic `event:` frames.
- Confirm the final visible answer appears through `choices[0].delta.content`.
- Confirm reasoning appears through `choices[0].delta.reasoning_content` and not in normal content.
- Confirm `deepseek-v4-flash-free` is unchanged when not in the whitelist.
- Confirm invalid API key still returns `401`.
- Confirm unknown model still returns `400`.
- Confirm non-streaming `qwen3.6-plus-free` behavior is unchanged in the first pass.
- Add a converter unit-style fixture if the project test setup remains lightweight:
  - input Anthropic text SSE -> output OpenAI content chunks
  - input Anthropic thinking SSE -> output OpenAI reasoning chunks
  - input Anthropic tool_use SSE -> output OpenAI tool_calls chunks
  - fragmented SSE input across chunks -> output remains correct

Implementation risk and mitigation:

- Risk: incorrectly converting a model that already returns OpenAI SSE.
  - Mitigation: whitelist only, default empty or targeted list.
- Risk: client incompatibility with `reasoning_content`.
  - Mitigation: keep final text in `content`; `reasoning_content` is additive.
- Risk: incomplete tool call conversion.
  - Mitigation: support the common `tool_use` and `input_json_delta` path first, preserve indexes carefully, and add fixtures.
- Risk: stream chunk boundaries split SSE frames.
  - Mitigation: buffer and parse by SSE event block rather than by raw chunk.
- Risk: duplicated finalization.
  - Mitigation: maintain `doneSent` state and emit `[DONE]` only once.

Suggested rollout:

- Add the converter and setting with `qwen3.6-plus-free` in the local default settings.
- Verify locally with the known API key and base URL `http://127.0.0.1:6446/v1`.
- Test a non-whitelisted model to prove passthrough is preserved.
- After validation, expose the whitelist setting in the Web UI if operators need runtime control.

Implemented:

- Added `src/converters/anthropicSseToOpenAi.ts` as an independent stream conversion module.
- Added `openAiStreamTransformModels` to system settings with input cleanup and de-duplication.
- Routed `/v1/chat/completions` `stream=true` requests through the converter only when the requested model is in the whitelist.
- Added model-page Web UI controls for hot-reloading the OpenAI stream conversion whitelist per model.
- Rebuilt and restarted the local Docker stack so the Web UI and runtime conversion are available at `http://127.0.0.1:6446/app`.

Verified:

- `npm run build:all` passes.
- Docker app and Redis services are healthy after rebuild.
- `GET /health` returns `status=ok`.
- `GET /admin/settings` shows `openAiStreamTransformModels` persisted with `qwen3.6-plus-free` in Docker data.
- Manual `qwen3.6-plus-free` streaming validation in local development returned OpenAI `data:` chunks with `reasoning_content`, final `content`, and terminal `data: [DONE]` without Anthropic `event:` frames.
