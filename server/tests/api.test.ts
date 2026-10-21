import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import crypto from 'node:crypto';
process.env.NODE_ENV = 'test';
import { buildApp } from '../src/app';
import { Activity, Team, User, WorkItem, priorityRank } from '../src/lib';

const TEST_URI = process.env.MONGO_URI_TEST ?? 'mongodb://127.0.0.1:27017/newtonite_test?replicaSet=rs0&directConnection=true';
const app = buildApp();
const key = () => crypto.randomUUID();
let payId: string, engId: string;
const ids: Record<string, string> = {};

async function login(email: string) {
  const a = request.agent(app);
  await a.post('/api/auth/login').send({ email, password: 'Password123!' }).expect(200);
  return a;
}
async function createItem(a: ReturnType<typeof request.agent>, over: object = {}) {
  const r = await a.post('/api/work-items').set('Idempotency-Key', key())
    .send({ title: 'Test item', category: 'Payments', team: payId, ...over });
  expect(r.status).toBe(201);
  return r.body.data;
}

beforeAll(async () => {
  await mongoose.connect(TEST_URI);
  await mongoose.connection.dropDatabase();
  await Promise.all([User, Team, WorkItem, Activity].map((m) => m.syncIndexes()));
  const [pay, eng] = await Team.insertMany([{ name: 'Pay', key: 'PAY' }, { name: 'Eng', key: 'ENG' }]);
  payId = String(pay._id); engId = String(eng._id);
  const passwordHash = await bcrypt.hash('Password123!', 4);
  const mk = (name: string, role: string, teamIds: any[]) => ({ name, email: `${name}@t.test`, role, teamIds, passwordHash });
  const us = await User.insertMany([
    mk('admin', 'admin', [pay._id, eng._id]), mk('mgr', 'manager', [pay._id]), mk('mgreng', 'manager', [eng._id]),
    mk('alice', 'member', [pay._id]), mk('bob', 'member', [pay._id]), mk('eve', 'member', [eng._id]),
  ]);
  us.forEach((u) => (ids[u.name] = String(u._id)));
});
afterAll(async () => { await mongoose.disconnect(); });

describe('authentication', () => {
  it('rejects unauthenticated access to every protected route', async () => {
    for (const [m, p] of [['get', '/api/work-items'], ['post', '/api/work-items'], ['get', '/api/dashboard/summary'], ['get', '/api/users'], ['get', '/api/auth/me']] as const)
      expect((await (request(app) as any)[m](p)).status).toBe(401);
  });
  it('rejects bad credentials and never returns the password hash', async () => {
    await request(app).post('/api/auth/login').send({ email: 'alice@t.test', password: 'nope' }).expect(401);
    const r = await request(app).post('/api/auth/login').send({ email: 'alice@t.test', password: 'Password123!' }).expect(200);
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash/);
    expect(r.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
  });
  it('logout clears the session cookie', async () => {
    const a = await login('alice@t.test');
    await a.post('/api/auth/logout').expect(200);
    await request(app).get('/api/auth/me').expect(401);
  });
});

describe('work item creation and validation', () => {
  it('creates an item with version 1, reporter from session (not client), and a created audit record', async () => {
    const a = await login('alice@t.test');
    const item = await createItem(a, { reporter: ids.bob, version: 99, status: 'Resolved' });
    expect(item.version).toBe(1); expect(item.status).toBe('Open'); expect(item.reporter.name).toBe('alice');
    const acts = await Activity.find({ item: item.id });
    expect(acts.map((x) => x.action)).toEqual(['created']);
  });
  it('rejects malformed input with 422 and bad JSON with 400', async () => {
    const a = await login('alice@t.test');
    expect((await a.post('/api/work-items').set('Idempotency-Key', key()).send({ title: 'x', category: 'Nope', team: payId })).status).toBe(422);
    expect((await a.post('/api/work-items').set('Idempotency-Key', key()).set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
  });
});

describe('Scenario 3: authorization and workflow enforcement', () => {
  it('hides other teams\' items (404), blocks cross-team creation (403) and edits', async () => {
    const mgr = await login('mgr@t.test'); const eve = await login('eve@t.test');
    const item = await createItem(mgr);
    await eve.get(`/api/work-items/${item.id}`).expect(404);
    await eve.patch(`/api/work-items/${item.id}`).send({ version: 1, title: 'hijack' }).expect(404);
    await eve.post(`/api/work-items/${item.id}/comments`).send({ body: 'hi' }).expect(404);
    await eve.post('/api/work-items').set('Idempotency-Key', key()).send({ title: 'sneaky', category: 'Payments', team: payId }).expect(403);
    const list = await eve.get('/api/work-items').expect(200);
    expect(list.body.data.every((i: any) => i.team.name === 'Eng')).toBe(true);
    expect((await WorkItem.findById(item.id))!.title).toBe('Test item');
  });
  it('members cannot change priority or others\' status; managers can', async () => {
    const mgr = await login('mgr@t.test'); const alice = await login('alice@t.test'); const bob = await login('bob@t.test');
    const item = await createItem(mgr, { assignee: ids.alice });
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'Critical' }).expect(403);
    await bob.patch(`/api/work-items/${item.id}`).send({ version: 1, status: 'In Progress' }).expect(403);
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 1, status: 'In Progress' }).expect(200);
    await mgr.patch(`/api/work-items/${item.id}`).send({ version: 2, priority: 'Critical' }).expect(200);
  });
  it('members cannot assign others, manager cannot assign across teams', async () => {
    const mgr = await login('mgr@t.test'); const alice = await login('alice@t.test');
    const item = await createItem(mgr);
    await alice.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', key()).send({ assignee: ids.bob, version: 1 }).expect(403);
    const r = await mgr.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', key()).send({ assignee: ids.eve, version: 1 });
    expect(r.status).toBe(422);
  });
  it('enforces transitions: invalid -> 422, resolution requires manager', async () => {
    const mgr = await login('mgr@t.test'); const alice = await login('alice@t.test');
    const item = await createItem(mgr, { assignee: ids.alice });
    const bad = await alice.patch(`/api/work-items/${item.id}`).send({ version: 1, status: 'Resolved' });
    expect(bad.status).toBe(422); expect(bad.body.error.code).toBe('INVALID_TRANSITION');
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 1, status: 'In Progress' }).expect(200);
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 2, status: 'In Review' }).expect(200);
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 3, status: 'Resolved' }).expect(403);
    await mgr.patch(`/api/work-items/${item.id}`).send({ version: 3, status: 'Resolved' }).expect(200);
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 4, status: 'Open' }).expect(403); // reopen: manager only
    expect((await alice.patch(`/api/work-items/${item.id}`).send({ version: 4, status: 'Bogus' })).status).toBe(422);
    expect((await alice.patch(`/api/work-items/${item.id}`).send({ version: 4, role: 'admin' })).status).toBe(422); // strict schema
  });
});

describe('Scenario 1: optimistic concurrency', () => {
  it('succeeds with the current version and bumps it', async () => {
    const mgr = await login('mgr@t.test'); const item = await createItem(mgr);
    const r = await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, title: 'Renamed' }).expect(200);
    expect(r.body.data.version).toBe(2); expect(r.body.data.title).toBe('Renamed');
  });
  it('rejects a stale version with 409 and returns the current item, without overwriting', async () => {
    const mgr = await login('mgr@t.test'); const admin = await login('admin@t.test'); const item = await createItem(mgr);
    await admin.patch(`/api/work-items/${item.id}`).send({ version: 1, title: 'Admin edit' }).expect(200);
    const r = await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, title: 'Stale edit' });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('VERSION_CONFLICT');
    expect(r.body.error.details.current.title).toBe('Admin edit'); expect(r.body.error.details.current.version).toBe(2);
    expect((await WorkItem.findById(item.id))!.title).toBe('Admin edit');
  });
  it('truly concurrent writers with the same version: exactly one wins', async () => {
    const mgr = await login('mgr@t.test'); const admin = await login('admin@t.test'); const item = await createItem(mgr);
    const rs = await Promise.all([
      mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, title: 'From manager' }),
      admin.patch(`/api/work-items/${item.id}`).send({ version: 1, title: 'From admin' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await WorkItem.findById(item.id))!.version).toBe(2);
    expect(await Activity.countDocuments({ item: item.id, action: 'updated' })).toBe(1);
  });
  it('two members racing to claim the same unassigned item: one wins, one gets 409', async () => {
    const mgr = await login('mgr@t.test'); const alice = await login('alice@t.test'); const bob = await login('bob@t.test');
    const item = await createItem(mgr);
    const rs = await Promise.all([
      alice.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', key()).send({ assignee: ids.alice, version: 1 }),
      bob.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', key()).send({ assignee: ids.bob, version: 1 }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = rs.find((r) => r.status === 200)!.body.data.assignee.name;
    expect(String((await WorkItem.findById(item.id))!.assignee)).toBe(ids[winner]);
    expect(await Activity.countDocuments({ item: item.id, action: 'assigned' })).toBe(1);
  });
});

describe('Scenario 2: idempotency', () => {
  const body = () => ({ title: 'Idempotent item', category: 'Payments', team: payId });
  it('requires an Idempotency-Key', async () => {
    const a = await login('alice@t.test');
    expect((await a.post('/api/work-items').send(body())).status).toBe(400);
  });
  it('sequential retry replays the original response and creates one item', async () => {
    const a = await login('alice@t.test'); const k = key(); const before = await WorkItem.countDocuments();
    const r1 = await a.post('/api/work-items').set('Idempotency-Key', k).send(body()).expect(201);
    const r2 = await a.post('/api/work-items').set('Idempotency-Key', k).send(body());
    expect(r2.status).toBe(201); expect(r2.headers['idempotent-replay']).toBe('true');
    expect(r2.body.data.id).toBe(r1.body.data.id);
    expect(await WorkItem.countDocuments()).toBe(before + 1);
    expect(await Activity.countDocuments({ item: r1.body.data.id })).toBe(1);
  });
  it('8 simultaneous identical requests create exactly one item', async () => {
    const a = await login('alice@t.test'); const k = key(); const before = await WorkItem.countDocuments();
    const rs = await Promise.all(Array.from({ length: 8 }, () => a.post('/api/work-items').set('Idempotency-Key', k).send(body())));
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(rs.some((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.filter((r) => r.status === 201).map((r) => r.body.data.id)).size).toBe(1);
    expect(await WorkItem.countDocuments()).toBe(before + 1);
  });
  it('rejects key reuse with a different payload, and a replayed assign applies once', async () => {
    const mgr = await login('mgr@t.test'); const k = key();
    await mgr.post('/api/work-items').set('Idempotency-Key', k).send(body()).expect(201);
    expect((await mgr.post('/api/work-items').set('Idempotency-Key', k).send({ ...body(), title: 'Different' })).status).toBe(422);
    const item = await createItem(mgr); const k2 = key();
    const p = { assignee: ids.alice, version: 1 };
    await mgr.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', k2).send(p).expect(200);
    const again = await mgr.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', k2).send(p);
    expect(again.status).toBe(200); expect(again.headers['idempotent-replay']).toBe('true');
    expect(await Activity.countDocuments({ item: item.id, action: 'assigned' })).toBe(1);
  });
  it('a failed create does not burn the key (rolled back with the transaction)', async () => {
    const a = await login('alice@t.test'); const k = key();
    const spy = vi.spyOn(Activity, 'create').mockRejectedValueOnce(new Error('boom'));
    const before = await WorkItem.countDocuments();
    expect((await a.post('/api/work-items').set('Idempotency-Key', k).send(body())).status).toBe(500);
    spy.mockRestore();
    expect(await WorkItem.countDocuments()).toBe(before); // no orphan item
    await a.post('/api/work-items').set('Idempotency-Key', k).send(body()).expect(201); // retry with same key works
  });
});

describe('Scenario 4: atomic mutation + audit', () => {
  it('records actor, before and after for status/priority/assignment changes in order', async () => {
    const mgr = await login('mgr@t.test'); const item = await createItem(mgr);
    await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, status: 'In Progress', priority: 'High' }).expect(200);
    await mgr.post(`/api/work-items/${item.id}/assign`).set('Idempotency-Key', key()).send({ assignee: ids.bob, version: 2 }).expect(200);
    const r = await mgr.get(`/api/work-items/${item.id}/activity`).expect(200);
    const acts = r.body.data;
    expect(acts.map((a: any) => a.action)).toEqual(['created', 'status_changed', 'priority_changed', 'assigned']);
    expect(acts[1].before).toEqual({ status: 'Open' }); expect(acts[1].after).toEqual({ status: 'In Progress' });
    expect(acts[3].after).toEqual({ assignee: ids.bob }); expect(acts.every((a: any) => a.actor.name === 'mgr')).toBe(true);
  });
  it('if the audit write fails, the item update is rolled back (no unaudited change)', async () => {
    const mgr = await login('mgr@t.test'); const item = await createItem(mgr);
    const spy = vi.spyOn(Activity, 'create').mockRejectedValueOnce(new Error('audit down'));
    expect((await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'Critical' })).status).toBe(500);
    spy.mockRestore();
    const db = await WorkItem.findById(item.id);
    expect(db!.priority).toBe('Medium'); expect(db!.version).toBe(1);
  });
  it('rejected mutations (409/403/422) leave no audit trail', async () => {
    const mgr = await login('mgr@t.test'); const alice = await login('alice@t.test'); const item = await createItem(mgr);
    await mgr.patch(`/api/work-items/${item.id}`).send({ version: 7, title: 'stale' }).expect(409);
    await alice.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'Low' }).expect(403);
    await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, status: 'Resolved' }).expect(422);
    expect(await Activity.countDocuments({ item: item.id })).toBe(1);
  });
  it('comments are persisted in the timeline', async () => {
    const alice = await login('alice@t.test'); const item = await createItem(alice);
    await alice.post(`/api/work-items/${item.id}/comments`).send({ body: 'Looking into it' }).expect(201);
    await alice.post(`/api/work-items/${item.id}/comments`).send({ body: '   ' }).expect(422);
    const acts = (await alice.get(`/api/work-items/${item.id}/activity`)).body.data;
    expect(acts.at(-1).action).toBe('comment'); expect(acts.at(-1).message).toBe('Looking into it');
  });
});

describe('search, filtering, pagination and dashboard', () => {
  beforeAll(async () => {
    await WorkItem.deleteMany({}); await Activity.deleteMany({});
    const base = { reporter: ids.alice, team: payId, category: 'Payments', description: '' };
    const docs = Array.from({ length: 25 }, (_, i) => {
      const pr = (['Low', 'Medium', 'High', 'Critical'] as const)[i % 4];
      return { ...base, key: `WI-${2000 + i}`, title: i < 5 ? `Refund failure ${i}` : `Task ${i}`, priority: pr, priorityRank: priorityRank(pr),
        status: i % 5 === 0 ? 'Blocked' : 'Open', assignee: i % 2 ? ids.alice : null,
        dueDate: i < 3 ? new Date(Date.now() - 864e5) : null, createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date(Date.now() - i * 1000) };
    });
    await WorkItem.insertMany(docs, { timestamps: false } as any);
    await WorkItem.insertMany([{ ...base, key: 'WI-9999', title: 'Eng secret', team: engId, priority: 'Critical', priorityRank: 4 }]);
  });
  it('paginates with metadata and stable, non-overlapping pages', async () => {
    const a = await login('alice@t.test');
    const p1 = (await a.get('/api/work-items?pageSize=10&page=1')).body, p3 = (await a.get('/api/work-items?pageSize=10&page=3')).body;
    expect(p1.meta).toEqual({ page: 1, pageSize: 10, total: 25, totalPages: 3 });
    expect(p1.data).toHaveLength(10); expect(p3.data).toHaveLength(5);
    const p2 = (await a.get('/api/work-items?pageSize=10&page=2')).body;
    expect(new Set([...p1.data, ...p2.data, ...p3.data].map((i: any) => i.id)).size).toBe(25);
    expect((await a.get('/api/work-items?pageSize=1000')).status).toBe(422);
  });
  it('filters, searches (id and text) and sorts server-side; never leaks other teams', async () => {
    const a = await login('alice@t.test');
    expect((await a.get('/api/work-items?status=Blocked')).body.meta.total).toBe(5);
    expect((await a.get('/api/work-items?priority=Critical,High')).body.meta.total).toBe(12);
    expect((await a.get('/api/work-items?assignee=me')).body.meta.total).toBe(12);
    expect((await a.get('/api/work-items?assignee=unassigned')).body.meta.total).toBe(13);
    expect((await a.get('/api/work-items?overdue=true')).body.meta.total).toBe(3);
    expect((await a.get('/api/work-items?q=wi-2003')).body.data[0].key).toBe('WI-2003');
    expect((await a.get('/api/work-items?q=refund')).body.meta.total).toBe(5);
    expect((await a.get('/api/work-items?q=secret')).body.meta.total).toBe(0);
    expect((await a.get('/api/work-items?status=Nonsense')).status).toBe(422);
    const byPrio = (await a.get('/api/work-items?sort=priority&order=desc&pageSize=5')).body.data;
    expect(byPrio.every((i: any) => i.priority === 'Critical')).toBe(true);
  });
  it('dashboard numbers come from the database and respect team scope', async () => {
    const a = await login('alice@t.test'); const eve = await login('eve@t.test');
    const d = (await a.get('/api/dashboard/summary')).body.data;
    expect(d.totalActive).toBe(25); expect(d.assignedToMe).toBe(12); expect(d.blocked).toBe(5); expect(d.overdue).toBe(3);
    expect(d.critical).toBe(await WorkItem.countDocuments({ team: payId, priority: 'Critical', status: { $ne: 'Resolved' } }));
    expect(Object.values(d.byStatus as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(25);
    const e = (await eve.get('/api/dashboard/summary')).body.data;
    expect(e.totalActive).toBe(1); expect(e.recent[0].key).toBe('WI-9999');
  });
});

describe('audit-driven regressions: sessions, validation, admin management', () => {
  it('logout revokes the token server-side (a copied cookie stops working)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'bob@t.test', password: 'Password123!' }).expect(200);
    const copied = res.headers['set-cookie'][0].split(';')[0];
    await request(app).get('/api/auth/me').set('Cookie', copied).expect(200);
    await request(app).post('/api/auth/logout').set('Cookie', copied).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', copied).expect(401);
  });
  it('logout revokes only that session; the same user\'s other session keeps working', async () => {
    const mk = async () => (await request(app).post('/api/auth/login').send({ email: 'bob@t.test', password: 'Password123!' }).expect(200)).headers['set-cookie'][0].split(';')[0];
    const phone = await mk(), laptop = await mk();
    await request(app).post('/api/auth/logout').set('Cookie', phone).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', phone).expect(401);
    await request(app).get('/api/auth/me').set('Cookie', laptop).expect(200);
  });
  it('rejects impossible calendar dates with 422 (not 500)', async () => {
    const mgr = await login('mgr@t.test');
    for (const d of ['2026-13-45', '2026-02-31', '2026-1-1'])
      expect((await mgr.post('/api/work-items').set('Idempotency-Key', key()).send({ title: 'Bad date', category: 'Payments', team: payId, dueDate: d })).status).toBe(422);
    const item = await createItem(mgr);
    expect((await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, dueDate: '2026-02-31' })).status).toBe(422);
    expect((await mgr.patch(`/api/work-items/${item.id}`).send({ version: 1, dueDate: '2026-12-31' })).status).toBe(200);
  });
  it('sends security headers', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-frame-options']).toBe('DENY');
  });
  it('only admins can manage users/teams; role change takes effect on the next request and revokes sessions', async () => {
    const mgr = await login('mgr@t.test'); const admin = await login('admin@t.test');
    expect((await mgr.post('/api/teams').send({ name: 'Nope', key: 'NO' })).status).toBe(403);
    expect((await mgr.post('/api/users').send({ name: 'X Y', email: 'x@t.test', password: 'longenough1', role: 'member' })).status).toBe(403);
    const t = await admin.post('/api/teams').send({ name: 'Risk', key: 'risk' }).expect(201);
    expect((await admin.post('/api/teams').send({ name: 'Risk', key: 'RSK' })).status).toBe(409);
    const u = await admin.post('/api/users').send({ name: 'New Hire', email: 'hire@t.test', password: 'longenough1', role: 'member', teamIds: [t.body.data.id] }).expect(201);
    expect(JSON.stringify(u.body)).not.toMatch(/passwordHash/);
    expect((await admin.post('/api/users').send({ name: 'Dup', email: 'hire@t.test', password: 'longenough1', role: 'member' })).status).toBe(409);
    expect((await admin.post('/api/users').send({ name: 'Weak', email: 'w@t.test', password: 'short', role: 'member' })).status).toBe(422);
    const hire = request.agent(app); await hire.post('/api/auth/login').send({ email: 'hire@t.test', password: 'longenough1' }).expect(200);
    await hire.get('/api/work-items').expect(200);
    await admin.patch(`/api/users/${u.body.data.id}`).send({ active: false }).expect(200);
    await hire.get('/api/work-items').expect(401); // deactivation revokes the live session
    expect((await admin.patch(`/api/users/${ids.admin}`).send({ role: 'member' })).status).toBe(422); // no self-demotion
    expect((await admin.patch(`/api/users/${u.body.data.id}`).send({ teamIds: ['bogus'] })).status).toBe(422);
  });
});
