# Newtonite Operations Hub

Internal operational-work management: work items, teams, role/resource-level authorization, collaboration timeline,
dashboard, server-side search/filter/pagination. Built for the Newtonite "Operations Under Pressure" challenge.

**Stack:** React + Vite + TypeScript + Tailwind (client) · Node + Express + TypeScript (API) · MongoDB + Mongoose · Zod · Vitest + Supertest.

## Structure
```
server/src/lib.ts      config, Mongoose models + indexes, workflow table, transaction helper
server/src/app.ts      Express app: auth, authorization, routes, idempotency, error handling
server/src/seed.ts     demo data (7 users, 4 teams, 150 items)
server/tests/          integration tests against a real MongoDB replica set
server/scripts/        init-rs.ts (single-node replica set bootstrap)
client/src/            App.tsx (views), api.ts (fetch + ApiError), ui.tsx (shared components)
```

## Prerequisites
Node 20+, and **MongoDB 5+ running as a replica set** (a single-node replica set is enough; transactions require it).

```bash
# Option A: Docker
docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
# Option B: local mongod
mongod --replSet rs0 --dbpath ./data --bind_ip 127.0.0.1
```

## Setup
```bash
cp .env.example server/.env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" server/.env   # the server refuses the placeholder secret
cd server && npm install && npm run db:init-rs   # one-time replica-set init (idempotent)
npm run seed                                      # WARNING: drops the configured database
npm run dev                                       # API on :4000
# second terminal
cd client && npm install && npm run dev           # UI on http://localhost:5173 (proxies /api to :4000)
```

## Tests
```bash
# 1. API integration tests (30) - real MongoDB replica set, isolated DB `newtonite_test` (dropped at start)
cd server && npm test
# 2. Live black-box checks (45) against a RUNNING API (+ seeded data). Use :4000 directly or :5173 via the Vite proxy
npm run seed && npm run dev &      # terminal 1
BASE=http://localhost:4000 npm run e2e
# 3. UI tests (2): renders the real React app and drives it against the running, seeded API
cd ../client && UI_API=http://localhost:4000 npm run test:ui
# type checks / production build
cd ../server && npm run typecheck; cd ../client && npm run typecheck && npm run build
```
`npm run e2e` and `test:ui` mutate the seeded dev database (they create items); re-run `npm run seed` to reset.

## Demo credentials (password for all: `Password123!`)
| Email | Role | Teams |
|---|---|---|
| admin@newtonite.test | Admin | all |
| manager.pay@newtonite.test | Manager | Payments Operations, Compliance |
| manager.eng@newtonite.test | Manager | Platform Engineering |
| member.pay@newtonite.test / member.pay2@newtonite.test | Member | Payments Operations |
| member.eng@newtonite.test | Member | Platform Engineering |
| member.cc@newtonite.test | Member | Customer Care |

## Permission model
| Action | Admin | Manager (own teams) | Member (own teams) |
|---|---|---|---|
| View/search/comment | all items | team items | team items |
| Create item | any team | own teams | own teams |
| Edit title/description/category/due | yes | yes | if reporter or assignee |
| Change status | yes | yes | if assignee |
| Resolve / reopen | yes | yes | **no** (approval step) |
| Change priority | yes | yes | **no** |
| Assign to others | yes | yes | **no** — may *claim* an unassigned item or *release* own |

Admin-only API (no UI screens): `POST /api/teams`, `POST /api/users`, `PATCH /api/users/:id` (name, role, teamIds, active, password).
Changing a user's role/teams/password or deactivating them **revokes their sessions immediately**; admins cannot demote or deactivate themselves.

Items of other teams return **404** (existence not revealed); forbidden actions on visible items return **403**.

## Workflow
`Open → In Progress | Blocked` · `In Progress → Open | Blocked | In Review` · `Blocked → Open | In Progress` · `In Review → In Progress | Resolved` · `Resolved → Open`.
Anything else is 422 `INVALID_TRANSITION`.

## API summary
All responses: `{ data, meta? }` or `{ error: { code, message, details? } }`. Mutations on items need `version`; create/assign need an `Idempotency-Key` header.
`POST /api/auth/login|logout`, `GET /api/auth/me`, `GET /api/work-items` (q, status, priority, category, team, assignee=me|unassigned|id, overdue, sort, order, page, pageSize≤100), `POST /api/work-items`, `GET|PATCH /api/work-items/:id`, `POST /api/work-items/:id/assign|comments`, `GET /api/work-items/:id/activity`, `GET|POST /api/teams`, `GET|POST /api/users`, `PATCH /api/users/:id`, `GET /api/users?team=`, `GET /api/dashboard/summary`.

## Known limitations
- **UI is tested with Testing Library/jsdom against the live API, not in a real browser**: layout/responsiveness, CSS and keyboard behaviour were not visually verified.
- Admin user/team management exists as API only (no UI screens); no team deletion/renaming endpoints.
- A user's role is global; manager rights are scoped by team membership (no per-team role). 
- Text search is word/stem-based (MongoDB `$text`), not substring/fuzzy; relevance is not used for ordering.
- `skip/limit` pagination: fine at tens of thousands of items, degrades for very deep pages (cursor pagination would be the next step).
- Sessions are server-side revocable (logout, deactivation) but there is no "list/revoke my devices" screen. Cookies are not `Secure` unless `COOKIE_SECURE=true` (set it behind HTTPS).
- No real-time push: other users' changes are discovered on refresh or via the 409 flow.
- No async notifications/processing was built (deliberately; see decisions). No login rate-limiting/lockout, password reset or MFA (login timing is equalised for unknown emails, but brute-force is not throttled). Comments cannot be edited/deleted.
- `USE_TRANSACTIONS=false` (standalone mongod) disables atomicity — development fallback only. If MongoDB is unavailable the API answers 503 `DB_UNAVAILABLE` (after ~5s) and recovers automatically; there is no read-only degraded mode.
- `JWT_SECRET` is mandatory; the server refuses to start without it or with the `.env.example` placeholder. Demo password `Password123!` exists only in seed data — never run the seed against a real environment.
- Dashboard counts are computed live per request (cheap with indexes at this scale; would be cached/pre-aggregated at much larger scale).
