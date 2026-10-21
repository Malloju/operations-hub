export {};
// Live black-box checks against a RUNNING stack. Usage: BASE=http://localhost:5173 npm run e2e   (needs `npm run seed` data)
const BASE = process.env.BASE ?? 'http://localhost:4000';
let fails = 0;
const check = (name: string, cond: boolean, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) {
    const r = await fetch(BASE + '/api' + path, { method, headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.startsWith('token=;') ? '' : sc.split(';')[0];
    const j: any = await r.json().catch(() => ({}));
    return { status: r.status, body: j, headers: r.headers, setCookie: sc };
  }
  async login(email: string) { const r = await this.call('POST', '/auth/login', { email, password: 'Password123!' }); if (r.status !== 200) throw new Error('login failed ' + email); return r.body.data; }
}
const id = () => crypto.randomUUID();
const mk = async (email: string) => { const c = new Client(); const me = await c.login(email); return { c, me }; };

const { c: mgr, me: mgrMe } = await mk('manager.pay@newtonite.test');
const { c: pay } = await mk('member.pay@newtonite.test');
const { c: pay2 } = await mk('member.pay2@newtonite.test');
const { c: eng } = await mk('member.eng@newtonite.test');
const { c: admin } = await mk('admin@newtonite.test');
const teams = (await mgr.call('GET', '/teams')).body.data; const payTeam = teams.find((t: any) => t.name === 'Payments Operations').id;
const users = (await mgr.call('GET', `/users?team=${payTeam}`)).body.data; const uid = (n: string) => users.find((u: any) => u.name === n)?.id;
const newItem = async (c = mgr, over = {}) => (await c.call('POST', '/work-items', { title: 'E2E item', category: 'Payments', team: payTeam, ...over }, { 'Idempotency-Key': id() })).body.data;

// 1/3 login/logout
const t = new Client();
const lr = await t.call('POST', '/auth/login', { email: 'manager.pay@newtonite.test', password: 'Password123!' });
check('login 200 + httpOnly cookie', lr.status === 200 && /HttpOnly/i.test(lr.setCookie ?? ''));
check('/auth/me returns user', (await t.call('GET', '/auth/me')).body.data?.role === 'manager');
await t.call('POST', '/auth/logout'); check('after logout /me is 401', (await t.call('GET', '/auth/me')).status === 401);
// logout must actually invalidate a stolen/copied token
const stolen = new Client(); await stolen.login('member.pay@newtonite.test'); const tok = stolen.cookie;
await stolen.call('POST', '/auth/logout'); const replay = new Client(); replay.cookie = tok;
check('token is invalid server-side after logout', (await replay.call('GET', '/auth/me')).status === 401, 'JWT still valid after logout');
check('wrong password 401', (await new Client().call('POST', '/auth/login', { email: 'admin@newtonite.test', password: 'x' })).status === 401);
check('login response has no passwordHash', !JSON.stringify(lr.body).includes('passwordHash'));
check('unauthenticated list 401', (await new Client().call('GET', '/work-items')).status === 401);
check('security headers set', lr.headers.get('x-content-type-options') === 'nosniff', 'missing X-Content-Type-Options');

// 4 authz
const item = await newItem(mgr, { assignee: uid('Priya Payments') });
check('create 201 + version 1', item?.version === 1);
check('cross-team read 404', (await eng.call('GET', `/work-items/${item.id}`)).status === 404);
check('cross-team create 403', (await eng.call('POST', '/work-items', { title: 'nope nope', category: 'Payments', team: payTeam }, { 'Idempotency-Key': id() })).status === 403);
check('member priority change 403', (await pay.call('PATCH', `/work-items/${item.id}`, { version: 1, priority: 'Critical' })).status === 403);
check('non-assignee status change 403', (await pay2.call('PATCH', `/work-items/${item.id}`, { version: 1, status: 'In Progress' })).status === 403);
check('member cannot assign others 403', (await pay.call('POST', `/work-items/${item.id}/assign`, { assignee: uid('Sam Payments'), version: 1 }, { 'Idempotency-Key': id() })).status === 403);
check('invalid transition 422', (await mgr.call('PATCH', `/work-items/${item.id}`, { version: 1, status: 'Resolved' })).status === 422);

// 5 status/assign/filter flow
const s1 = await pay.call('PATCH', `/work-items/${item.id}`, { version: 1, status: 'In Progress' });
check('assignee status update 200, v2', s1.status === 200 && s1.body.data.version === 2 && s1.body.data.status === 'In Progress');
const a1 = await mgr.call('POST', `/work-items/${item.id}/assign`, { assignee: uid('Sam Payments'), version: 2 }, { 'Idempotency-Key': id() });
check('manager assign 200', a1.status === 200 && a1.body.data.assignee.name === 'Sam Payments');
const fl = await mgr.call('GET', `/work-items?status=In Progress&assignee=${uid('Sam Payments')}&q=${item.key}`);
check('filter+search finds item', fl.body.data?.some((i: any) => i.id === item.id));

// 6 concurrency over HTTP
const cur = (await mgr.call('GET', `/work-items/${item.id}`)).body.data;
const race = await Promise.all([mgr.call('PATCH', `/work-items/${item.id}`, { version: cur.version, title: 'Writer A' }), admin.call('PATCH', `/work-items/${item.id}`, { version: cur.version, title: 'Writer B' })]);
check('parallel writers => one 200 and one 409', race.map((r) => r.status).sort().join() === '200,409', JSON.stringify(race.map((r) => r.status)));
const stale = await mgr.call('PATCH', `/work-items/${item.id}`, { version: cur.version, title: 'Stale' });
check('stale write 409 with current item', stale.status === 409 && stale.body.error.code === 'VERSION_CONFLICT' && stale.body.error.details.current.version === cur.version + 1);

// 7 idempotency over HTTP
const k = id(); const before = (await mgr.call('GET', '/work-items?pageSize=1')).body.meta.total;
const dup = await Promise.all(Array.from({ length: 10 }, () => mgr.call('POST', '/work-items', { title: 'Dup test', category: 'Payments', team: payTeam }, { 'Idempotency-Key': k })));
const after = (await mgr.call('GET', '/work-items?pageSize=1')).body.meta.total;
check('10 identical parallel creates => exactly 1 new item', after === before + 1, `before=${before} after=${after} statuses=${dup.map((d) => d.status)}`);
check('no 5xx from duplicate storm', dup.every((d) => d.status < 500), JSON.stringify(dup.map((d) => d.status)));

// throughput: many different-key creates in parallel (counter hotspot)
const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => mgr.call('POST', '/work-items', { title: `Burst ${i}`, category: 'Operations', team: payTeam }, { 'Idempotency-Key': id() })));
check('25 parallel creates all 201', burst.every((b) => b.status === 201), JSON.stringify(burst.map((b) => b.status)));
check('burst keys unique', new Set(burst.map((b) => b.body.data?.key)).size === 25);

// 8 audit consistency
const acts = (await mgr.call('GET', `/work-items/${item.id}/activity`)).body.data;
check('audit: created,status_changed,assigned,updated in order', acts.map((a: any) => a.action).join() === 'created,status_changed,assigned,updated', acts.map((a: any) => a.action).join());
check('audit: version == 1 + number of mutation events', cur.version + 1 === 1 + acts.filter((a: any) => a.action !== 'comment' && a.action !== 'created').length);

// edge-case input hardening
const bad = async (name: string, p: Promise<{ status: number }>, ok: number[] = [400, 422]) => { const r = await p; check(`${name} -> ${r.status}`, ok.includes(r.status)); };
await bad('impossible due date on create', mgr.call('POST', '/work-items', { title: 'Bad date', category: 'Payments', team: payTeam, dueDate: '2026-13-45' }, { 'Idempotency-Key': id() }));
await bad('impossible due date on patch', mgr.call('PATCH', `/work-items/${item.id}`, { version: 99, dueDate: '2026-02-31' }));
await bad('version as string', mgr.call('PATCH', `/work-items/${item.id}`, { version: '2', title: 'abc' }));
await bad('empty patch', mgr.call('PATCH', `/work-items/${item.id}`, { version: 1 }));
await bad('array JSON body', mgr.call('POST', '/work-items', undefined, { 'Idempotency-Key': id() }, '[]'));
await bad('malformed JSON', mgr.call('POST', '/auth/login', undefined, {}, '{nope'));
await bad('page=0', mgr.call('GET', '/work-items?page=0'));
await bad('bad enum filter', mgr.call('GET', '/work-items?priority=Urgent'));
await bad('non-ObjectId id', mgr.call('GET', '/work-items/not-an-id'), [404]);
await bad('team id garbage on create', mgr.call('POST', '/work-items', { title: 'abc', category: 'Payments', team: 'zzz' }, { 'Idempotency-Key': id() }), [400, 403, 422]);
await bad('Mongo operator injection in login', new Client().call('POST', '/auth/login', { email: { $ne: '' }, password: { $ne: '' } }), [400, 422]);
await bad('operator injection in assignee filter', mgr.call('GET', '/work-items?assignee[$ne]=x'), [200, 400, 422]);
await bad('search with quote/regex chars', mgr.call('GET', '/work-items?q=%22(%5B*'), [200]);
await bad('very long q', mgr.call('GET', '/work-items?q=' + 'a'.repeat(500)), [400, 422]);
await bad('unknown route', mgr.call('GET', '/nope'), [404]);
await bad('form-encoded POST rejected', new Client().call('POST', '/auth/logout', undefined, { 'Content-Type': 'text/plain' }, 'a=b'), [200, 415]);
const fm = await fetch(BASE + '/api/work-items', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: mgr.cookie, 'Idempotency-Key': id() }, body: 'title=csrf' });
check('CSRF-style form POST rejected (415)', fm.status === 415);

// timing side-channel (user enumeration)
const time = async (email: string) => { const s = performance.now(); await new Client().call('POST', '/auth/login', { email, password: 'wrong-password' }); return performance.now() - s; };
await time('admin@newtonite.test'); const tk = await time('admin@newtonite.test'); const tu = await time('ghost@newtonite.test');
check(`login timing similar for known/unknown email (known ${tk.toFixed(0)}ms, unknown ${tu.toFixed(0)}ms)`, tu > tk * 0.5, 'unknown email returns much faster -> enumerable');

// dashboard consistency vs list
const d = (await mgr.call('GET', '/dashboard/summary')).body.data; const l = (await mgr.call('GET', '/work-items?status=Blocked&pageSize=1')).body.meta.total;
check('dashboard blocked == list blocked', d.blocked === l, `${d.blocked} vs ${l}`);
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED'); process.exit(fails ? 1 : 0);
