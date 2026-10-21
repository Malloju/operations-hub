import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import {
  Activity, CATEGORIES, ROLES, config, Counter, HttpError, Idem, oid, PRIORITIES, priorityRank, STATUSES, Status,
  Session, Team, TRANSITIONS, tx, User, WorkItem,
} from './lib.js';

type Ctx = { id: string; role: 'admin' | 'manager' | 'member'; teamIds: string[]; name: string; email: string };
declare global { namespace Express { interface Request { user?: Ctx } } }

const ok = (res: Response, data: unknown, status = 200, meta?: unknown) => res.status(status).json({ data, ...(meta ? { meta } : {}) });
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(422, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten());
  return r.data;
};

// ---------- authentication ----------
function auth(req: Request, _res: Response, next: NextFunction) {
  (async () => {
    const token = req.cookies?.token;
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    let sub: string, jti: string;
    try { const c = jwt.verify(token, config.jwtSecret) as { sub: string; jti: string }; sub = c.sub; jti = c.jti; }
    catch { throw new HttpError(401, 'UNAUTHENTICATED', 'Session invalid or expired'); }
    // Re-load the user each request so role/team changes and deactivation apply immediately.
    const [u, session] = await Promise.all([User.findById(sub).lean(), Session.exists({ _id: jti, userId: sub })]);
    if (!u || !u.active || !session) throw new HttpError(401, 'UNAUTHENTICATED', 'Session revoked or account unavailable');
    req.user = { id: String(u._id), role: u.role as Ctx['role'], teamIds: u.teamIds.map(String), name: u.name, email: u.email };
  })().then(() => next(), next);
}
const requireRole = (...roles: Ctx['role'][]) => (req: Request, _res: Response, next: NextFunction) =>
  roles.includes(req.user!.role) ? next() : next(new HttpError(403, 'FORBIDDEN', 'Your role does not permit this action'));

// ---------- authorization (resource level) ----------
const inTeam = (u: Ctx, teamId: string) => u.role === 'admin' || u.teamIds.includes(teamId);
const isPrivileged = (u: Ctx, teamId: string) => u.role === 'admin' || (u.role === 'manager' && u.teamIds.includes(teamId));
const forbid = (msg: string): never => { throw new HttpError(403, 'FORBIDDEN', msg); };
const teamScope = (u: Ctx) => (u.role === 'admin' ? {} : { team: { $in: u.teamIds.map((t) => oid(t)!) } });

const serialize = (d: any) => d && ({ ...d, id: String(d._id), _id: undefined });
const populateItem = (q: any) => q.populate('reporter assignee', 'name email').populate('team', 'name key');

async function loadAccessible(u: Ctx, id: string, s?: ClientSession) {
  const _id = oid(id);
  if (!_id) throw new HttpError(404, 'NOT_FOUND', 'Work item not found');
  const item = await WorkItem.findById(_id).session(s ?? null).lean();
  // 404 (not 403) for other teams' items: don't reveal existence.
  if (!item || !inTeam(u, String(item.team))) throw new HttpError(404, 'NOT_FOUND', 'Work item not found');
  return item;
}
const fullItem = async (id: unknown) => serialize(await populateItem(WorkItem.findById(id)).lean());

function conflict(current: any): never {
  throw new HttpError(409, 'VERSION_CONFLICT',
    'This work item was changed by someone else since you loaded it. Review the latest version and retry.', { current });
}

// ---------- idempotency ----------
async function idempotent(req: Request, res: Response, scope: string, fn: (s?: ClientSession) => Promise<{ status: number; body: any }>) {
  const key = req.header('Idempotency-Key');
  if (!key || key.length > 128) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (max 128 chars) is required');
  const userId = oid(req.user!.id)!;
  const hash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
  try {
    const r = await tx(async (s) => {
      await Idem.create([{ userId, key, scope: scope, hash }], { session: s });
      const out = await fn(s);
      await Idem.updateOne({ userId, key }, { $set: { response: out } }, { session: s });
      return out;
    });
    return res.status(r.status).json(r.body);
  } catch (e: any) {
    if (e?.code === 11000 && /idempotency/i.test(e.message ?? 'idempotency')) {
      const rec = await Idem.findOne({ userId, key }).lean();
      if (rec && (rec.hash !== hash || rec.scope !== scope))
        throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
      if (rec?.response) return res.status(rec.response.status).set('Idempotent-Replay', 'true').json(rec.response.body);
      throw new HttpError(409, 'REQUEST_IN_PROGRESS', 'An identical request is still being processed; retry shortly');
    }
    // Non-transactional mode: release the key so a failed request can be retried.
    if (!config.useTx) await Idem.deleteOne({ userId, key });
    throw e;
  }
}

// ---------- schemas ----------
const validDate = (v: string) => { const d = new Date(v); return !isNaN(+d) && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || d.toISOString().slice(0, 10) === v); };
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/).refine(validDate, 'Not a real calendar date').nullable();
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10); // compared when the email is unknown so response time doesn't reveal which emails exist
const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(10000).default(''),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).default('Medium'),
  team: z.string(),
  assignee: z.string().nullable().optional(),
  dueDate: dueDate.optional(),
});
const patchSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().max(10000).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueDate: dueDate.optional(),
}).strict();
const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().optional(), priority: z.string().optional(), category: z.string().optional(),
  team: z.string().optional(), assignee: z.string().optional(),
  overdue: z.enum(['true', 'false']).optional(),
  sort: z.enum(['priority', 'createdAt', 'updatedAt']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const inList = (v: string | undefined, allowed: readonly string[]) => {
  if (!v) return undefined;
  const vals = v.split(',').filter(Boolean);
  if (vals.some((x) => !allowed.includes(x))) throw new HttpError(422, 'VALIDATION_ERROR', `Invalid filter value in "${v}"`);
  return { $in: vals };
};
const toDate = (d: string | null | undefined) => (d ? new Date(d) : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_q, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => { // request log without bodies/cookies/secrets
    const t = Date.now();
    res.on('finish', () => { if (process.env.NODE_ENV !== 'test') console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`); });
    next();
  });
  // CSRF defence in depth: cookie is SameSite=Lax and mutations must be JSON (not a simple cross-site form POST).
  app.use((req, _res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.headers['content-length'] !== '0' && !req.is('application/json'))
      return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    next();
  });

  const api = express.Router();
  app.use('/api', api);
  api.get('/health', (_q, res) => ok(res, { status: 'ok' }));

  // ----- auth -----
  api.post('/auth/login', wrap(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const u = await User.findOne({ email: email.toLowerCase() });
    const pwOk = await bcrypt.compare(password, u?.passwordHash ?? DUMMY_HASH);
    const valid = !!u && u.active && pwOk;
    if (!valid) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const jti = crypto.randomUUID();
    await Session.create({ _id: jti, userId: u!._id });
    const token = jwt.sign({ sub: String(u!._id), jti }, config.jwtSecret, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 8 * 3600 * 1000 });
    ok(res, { id: String(u!._id), name: u!.name, email: u!.email, role: u!.role, teamIds: u!.teamIds.map(String) });
  }));
  // Logout deletes this login's session row, so the token (and any copy of it) stops working at once; the user's other sessions are untouched.
  api.post('/auth/logout', wrap(async (req, res) => {
    try { const c = jwt.verify(req.cookies?.token ?? '', config.jwtSecret, { ignoreExpiration: true }) as { jti: string }; await Session.deleteOne({ _id: c.jti }); } catch { /* no/invalid cookie: nothing to revoke */ }
    res.clearCookie('token'); ok(res, { loggedOut: true });
  }));
  api.get('/auth/me', auth, (req, res) => ok(res, req.user));

  // ----- directory -----
  api.get('/teams', auth, wrap(async (req, res) => {
    const u = req.user!;
    const teams = await Team.find(u.role === 'admin' ? {} : { _id: { $in: u.teamIds } }).sort('name').lean();
    ok(res, teams.map(serialize));
  }));
  api.get('/users', auth, wrap(async (req, res) => {
    const u = req.user!;
    const filter: any = { active: true };
    if (u.role !== 'admin') filter.teamIds = { $in: u.teamIds.map((t) => oid(t)!) }; // only colleagues
    if (typeof req.query.team === 'string' && oid(req.query.team)) filter.teamIds = oid(req.query.team);
    if (u.role !== 'admin' && typeof req.query.team === 'string' && !u.teamIds.includes(req.query.team)) return ok(res, []);
    const users = await User.find(filter, 'name email role teamIds').sort('name').limit(500).lean();
    ok(res, users.map(serialize));
  }));


  // ----- admin: teams & users -----
  api.post('/teams', auth, requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), key: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/) }), req.body);
    ok(res, serialize((await Team.create(b)).toObject()), 201);
  }));
  const publicUser = (u: any) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, teamIds: u.teamIds.map(String), active: u.active });
  const validTeams = async (ids: string[]) => {
    const oids = ids.map((i) => oid(i)); if (oids.some((x) => !x) || (await Team.countDocuments({ _id: { $in: oids } })) !== new Set(ids).size) throw new HttpError(422, 'VALIDATION_ERROR', 'Unknown team id');
    return oids as NonNullable<(typeof oids)[number]>[];
  };
  api.post('/users', auth, requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(100), email: z.string().email(), password: z.string().min(10).max(200), role: z.enum(ROLES), teamIds: z.array(z.string()).max(50).default([]) }), req.body);
    const u = await User.create({ name: b.name, email: b.email, role: b.role, teamIds: await validTeams(b.teamIds), passwordHash: await bcrypt.hash(b.password, 10) });
    ok(res, publicUser(u), 201);
  }));
  api.patch('/users/:id', auth, requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(100), role: z.enum(ROLES), teamIds: z.array(z.string()).max(50), active: z.boolean(), password: z.string().min(10).max(200) }).partial().strict(), req.body);
    const id = oid(req.params.id); if (!id) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    if (id.equals(req.user!.id) && ((b.role && b.role !== 'admin') || b.active === false)) throw new HttpError(422, 'VALIDATION_ERROR', 'Admins cannot demote or deactivate themselves');
    const set: any = {}; if (b.name) set.name = b.name; if (b.role) set.role = b.role; if (b.active !== undefined) set.active = b.active;
    if (b.teamIds) set.teamIds = await validTeams(b.teamIds); if (b.password) set.passwordHash = await bcrypt.hash(b.password, 10);
    if (!Object.keys(set).length) throw new HttpError(422, 'VALIDATION_ERROR', 'No changes supplied');
    // Permission-relevant changes revoke existing sessions so they cannot outlive the old role/team.
    const revoke = b.role || b.teamIds || b.active === false || b.password;
    const u = await User.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    if (revoke) await Session.deleteMany({ userId: id });
    ok(res, publicUser(u));
  }));

  // ----- work items -----
  api.get('/work-items', auth, wrap(async (req, res) => {
    const u = req.user!;
    const p = parse(listSchema, req.query);
    const filter: any = { ...teamScope(u) };
    const st = inList(p.status, STATUSES); if (st) filter.status = st;
    const pr = inList(p.priority, PRIORITIES); if (pr) filter.priority = pr;
    const ca = inList(p.category, CATEGORIES); if (ca) filter.category = ca;
    if (p.team) {
      if (!oid(p.team) || !inTeam(u, p.team)) return ok(res, [], 200, { page: p.page, pageSize: p.pageSize, total: 0, totalPages: 0 });
      filter.team = oid(p.team);
    }
    if (p.assignee === 'me') filter.assignee = oid(u.id);
    else if (p.assignee === 'unassigned') filter.assignee = null;
    else if (p.assignee) { const a = oid(p.assignee); if (!a) throw new HttpError(422, 'VALIDATION_ERROR', 'Invalid assignee'); filter.assignee = a; }
    if (p.overdue === 'true') { filter.dueDate = { $lt: new Date() }; filter.status = { $ne: 'Resolved' }; }
    if (p.q) {
      if (/^[a-z]+-\d+$/i.test(p.q)) filter.key = p.q.toUpperCase();
      else filter.$text = { $search: p.q };
    }
    const dir = p.order === 'asc' ? 1 : -1;
    const sortField = p.sort === 'priority' ? 'priorityRank' : p.sort;
    const sort: any = { [sortField]: dir, _id: dir }; // _id tiebreak => stable pagination
    const [items, total] = await Promise.all([
      populateItem(WorkItem.find(filter).sort(sort).skip((p.page - 1) * p.pageSize).limit(p.pageSize)).lean(),
      WorkItem.countDocuments(filter),
    ]);
    ok(res, items.map(serialize), 200, { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });
  }));

  api.post('/work-items', auth, wrap(async (req, res) => {
    const u = req.user!;
    const b = parse(createSchema, req.body);
    if (!oid(b.team) || !inTeam(u, b.team)) forbid('You can only create work items for your own teams');
    await idempotent(req, res, 'create-work-item', async (s) => {
      const team = await Team.findById(b.team).session(s ?? null).lean();
      if (!team) throw new HttpError(422, 'VALIDATION_ERROR', 'Unknown team');
      let assignee = null as ReturnType<typeof oid>;
      if (b.assignee) {
        assignee = oid(b.assignee);
        const a = assignee && (await User.findOne({ _id: assignee, active: true, teamIds: team._id }).session(s ?? null).lean());
        if (!a) throw new HttpError(422, 'VALIDATION_ERROR', 'Assignee must be an active member of the team');
        if (!isPrivileged(u, b.team) && String(assignee) !== u.id) forbid('Only managers can assign work to others');
      }
      const c = await Counter.findOneAndUpdate({ _id: 'workItem' }, { $inc: { seq: 1 } }, { upsert: true, new: true, session: s });
      const [item] = await WorkItem.create([{
        key: `WI-${1000 + (c!.seq ?? 0)}`, title: b.title, description: b.description, category: b.category,
        priority: b.priority, priorityRank: priorityRank(b.priority), team: team._id, reporter: oid(u.id),
        assignee, dueDate: toDate(b.dueDate),
      }], { session: s });
      await Activity.create([{ item: item._id, actor: oid(u.id), action: 'created', after: { title: b.title, priority: b.priority, team: team.name, assignee: b.assignee ?? null }, message: 'Created work item' }], { session: s });
      return { status: 201, body: { data: serialize(await populateItem(WorkItem.findById(item._id).session(s ?? null)).lean()) } };
    });
  }));

  api.get('/work-items/:id', auth, wrap(async (req, res) => {
    const item = await loadAccessible(req.user!, req.params.id);
    ok(res, await fullItem(item._id));
  }));

  api.patch('/work-items/:id', auth, wrap(async (req, res) => {
    const u = req.user!;
    const b = parse(patchSchema, req.body);
    const { version, ...changes } = b;
    if (!Object.keys(changes).length) throw new HttpError(422, 'VALIDATION_ERROR', 'No changes supplied');
    const result = await tx(async (s) => {
      const cur = await loadAccessible(u, req.params.id, s);
      if (cur.version !== version) conflict(await fullItem(cur._id));
      const team = String(cur.team);
      const priv = isPrivileged(u, team);
      const isAssignee = cur.assignee && String(cur.assignee) === u.id;
      const isReporter = String(cur.reporter) === u.id;
      const set: any = {}; const events: any[] = [];

      const fieldEdits = ['title', 'description', 'category', 'dueDate'] as const;
      const changedFields = fieldEdits.filter((f) => f in changes && !same(f === 'dueDate' ? toDate(changes.dueDate as any) : (changes as any)[f], (cur as any)[f]));
      if (changedFields.length) {
        if (!(priv || isAssignee || isReporter)) forbid('Only the reporter, assignee or a team manager can edit this item');
        const before: any = {}, after: any = {};
        for (const f of changedFields) { before[f] = (cur as any)[f]; after[f] = f === 'dueDate' ? toDate(changes.dueDate as any) : (changes as any)[f]; set[f] = after[f]; }
        events.push({ action: 'updated', before, after });
      }
      if (changes.priority && changes.priority !== cur.priority) {
        if (!priv) forbid('Only managers can change priority');
        set.priority = changes.priority; set.priorityRank = priorityRank(changes.priority);
        events.push({ action: 'priority_changed', before: { priority: cur.priority }, after: { priority: changes.priority } });
      }
      if (changes.status && changes.status !== cur.status) {
        const from = cur.status as Status, to = changes.status;
        if (!TRANSITIONS[from].includes(to))
          throw new HttpError(422, 'INVALID_TRANSITION', `Cannot move from "${from}" to "${to}". Allowed: ${TRANSITIONS[from].join(', ')}`);
        if (!(priv || isAssignee)) forbid('Only the assignee or a team manager can change status');
        if ((to === 'Resolved' || from === 'Resolved') && !priv) forbid('Only managers can approve resolution or reopen items');
        set.status = to;
        events.push({ action: 'status_changed', before: { status: from }, after: { status: to } });
      }
      if (!events.length) return { id: cur._id };

      // Compare-and-set on version: loses cleanly if another writer committed between our read and write.
      const upd = await WorkItem.findOneAndUpdate({ _id: cur._id, version }, { $set: set, $inc: { version: 1 } }, { new: true, session: s });
      if (!upd) conflict(await fullItem(cur._id));
      const order = ['updated', 'status_changed', 'priority_changed'];
      events.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
      await Activity.create(events.map((e) => ({ ...e, item: cur._id, actor: oid(u.id) })), { session: s, ordered: true });
      return { id: cur._id };
    });
    ok(res, await fullItem(result.id)); // read AFTER commit so the client sees the confirmed state
  }));

  api.post('/work-items/:id/assign', auth, wrap(async (req, res) => {
    const u = req.user!;
    const b = parse(z.object({ assignee: z.string().nullable(), version: z.number().int().min(1) }), req.body);
    await idempotent(req, res, `assign:${req.params.id}`, async (s) => {
      const cur = await loadAccessible(u, req.params.id, s);
      if (cur.version !== b.version) conflict(await fullItem(cur._id));
      const team = String(cur.team), priv = isPrivileged(u, team);
      const prev = cur.assignee ? String(cur.assignee) : null;
      if (b.assignee === prev) throw new HttpError(422, 'NO_CHANGE', 'Item is already assigned to that user');
      // Members may only claim an unassigned item for themselves, or release their own assignment.
      if (!priv) {
        const claim = b.assignee === u.id && prev === null, release = b.assignee === null && prev === u.id;
        if (!claim && !release) forbid('Members can only claim unassigned work for themselves or release their own work');
      }
      let target = null as ReturnType<typeof oid>;
      if (b.assignee) {
        target = oid(b.assignee);
        const a = target && (await User.findOne({ _id: target, active: true, teamIds: cur.team }).session(s ?? null).lean());
        if (!a) throw new HttpError(422, 'VALIDATION_ERROR', 'Assignee must be an active member of the item\'s team');
      }
      // Two users claiming at once: only one CAS on {version} succeeds; the loser gets 409.
      const upd = await WorkItem.findOneAndUpdate({ _id: cur._id, version: b.version }, { $set: { assignee: target }, $inc: { version: 1 } }, { new: true, session: s });
      if (!upd) conflict(await fullItem(cur._id));
      await Activity.create([{ item: cur._id, actor: oid(u.id), action: 'assigned', before: { assignee: prev }, after: { assignee: b.assignee } }], { session: s });
      return { status: 200, body: { data: serialize(await populateItem(WorkItem.findById(cur._id).session(s ?? null)).lean()) } };
    });
  }));

  api.post('/work-items/:id/comments', auth, wrap(async (req, res) => {
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
    const item = await loadAccessible(req.user!, req.params.id);
    const [c] = await Activity.create([{ item: item._id, actor: oid(req.user!.id), action: 'comment', message: body }]);
    ok(res, serialize(await Activity.findById(c._id).populate('actor', 'name').lean()), 201);
  }));

  api.get('/work-items/:id/activity', auth, wrap(async (req, res) => {
    const item = await loadAccessible(req.user!, req.params.id);
    const page = Math.max(1, Number(req.query.page) || 1), pageSize = Math.min(100, Number(req.query.pageSize) || 50);
    const [rows, total] = await Promise.all([
      Activity.find({ item: item._id }).sort({ createdAt: 1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).populate('actor', 'name').lean(),
      Activity.countDocuments({ item: item._id }),
    ]);
    ok(res, rows.map(serialize), 200, { page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }));

  // ----- dashboard -----
  api.get('/dashboard/summary', auth, wrap(async (req, res) => {
    const u = req.user!, scope = teamScope(u), now = new Date();
    const active = { ...scope, status: { $ne: 'Resolved' } };
    const attention = { ...active, $or: [{ priority: 'Critical' }, { status: 'Blocked' }, { dueDate: { $lt: now } }, { priority: 'High', assignee: null }] };
    const [totalActive, assignedToMe, critical, high, blocked, overdue, byStatus, recent, needsAttention] = await Promise.all([
      WorkItem.countDocuments(active),
      WorkItem.countDocuments({ ...active, assignee: oid(u.id) }),
      WorkItem.countDocuments({ ...active, priority: 'Critical' }),
      WorkItem.countDocuments({ ...active, priority: 'High' }),
      WorkItem.countDocuments({ ...active, status: 'Blocked' }),
      WorkItem.countDocuments({ ...active, dueDate: { $lt: now } }),
      WorkItem.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      populateItem(WorkItem.find(scope).sort({ updatedAt: -1 }).limit(6)).lean(),
      populateItem(WorkItem.find(attention).sort({ priorityRank: -1, dueDate: 1 }).limit(10)).lean(),
    ]);
    const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of byStatus) statusCounts[r._id] = r.count;
    ok(res, { totalActive, assignedToMe, critical, high, blocked, overdue, byStatus: statusCounts, recent: recent.map(serialize), needsAttention: needsAttention.map(serialize) });
  }));

  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
    if (err?.code === 11000) return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with that unique value already exists' } });
    if (/ServerSelection|MongoNetwork|NotConnected|buffering timed out/i.test(`${err?.name} ${err?.message}`))
      return res.status(503).json({ error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' } });
    if (process.env.NODE_ENV !== 'test') console.error(err); // server-side only; clients never see internals
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  });
  return app;
}
