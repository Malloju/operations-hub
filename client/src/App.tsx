import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, CATEGORIES, Item, Me, PRIORITIES, STATUSES, TRANSITIONS, uuid } from './api';
import { ErrorBox, fmt, fmtDate, isOverdue, Modal, PriorityBadge, Spinner, StatusBadge, Toast } from './ui';

type Notify = (msg: string, kind?: 'ok' | 'err') => void;
type Team = { id: string; name: string };
type User = { id: string; name: string; role: string; teamIds: string[] };

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<'dashboard' | 'items'>('dashboard');
  const [preset, setPreset] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nav, setNav] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [tick, setTick] = useState(0); // bumps to refresh lists after mutations
  const notify: Notify = (msg, kind = 'ok') => setToast({ msg, kind });

  useEffect(() => { api('/auth/me').then((r) => setMe(r.data)).catch(() => setMe(null)); }, []);
  if (me === undefined) return <Spinner />;
  if (!me) return <Login onLogin={setMe} />;

  const go = (v: 'dashboard' | 'items', p: Record<string, string> = {}) => { setView(v); setPreset(p); setNav(false); };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setMe(null); };
  const NavBtn = ({ v, label }: { v: 'dashboard' | 'items'; label: string }) => (
    <button onClick={() => go(v)} aria-current={view === v ? 'page' : undefined}
      className={`block w-full rounded-md px-3 py-2 text-left text-sm ${view === v ? 'bg-teal-900 text-white' : 'text-stone-300 hover:bg-stone-800'}`}>{label}</button>
  );
  return (
    <div className="min-h-screen md:flex">
      <header className="flex items-center justify-between bg-stone-900 px-4 py-3 text-white md:hidden">
        <span className="font-semibold">Operations Hub</span>
        <button className="rounded border border-stone-600 px-2 py-1 text-sm" aria-expanded={nav} onClick={() => setNav(!nav)}>Menu</button>
      </header>
      <aside className={`${nav ? 'block' : 'hidden'} w-full shrink-0 bg-stone-900 p-4 md:block md:min-h-screen md:w-60`}>
        <div className="mb-6 hidden md:block"><div className="font-semibold text-white">Newtonite</div><div className="text-xs uppercase tracking-widest text-teal-400">Operations Hub</div></div>
        <nav aria-label="Main" className="space-y-1"><NavBtn v="dashboard" label="Dashboard" /><NavBtn v="items" label="Work items" /></nav>
        <div className="mt-6 border-t border-stone-700 pt-4 text-sm text-stone-300">
          <div className="font-medium text-white">{me.name}</div><div className="text-xs capitalize">{me.role}</div>
          <button className="mt-3 text-xs underline" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{view === 'dashboard' ? 'Dashboard' : 'Work items'}</h1>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New work item</button>
        </div>
        {view === 'dashboard' ? <Dashboard key={tick} go={go} open={setOpenId} /> : <Items key={JSON.stringify(preset)} preset={preset} tick={tick} open={setOpenId} />}
      </main>
      {openId && <Detail id={openId} me={me} onClose={() => setOpenId(null)} notify={notify} changed={() => setTick((t) => t + 1)} />}
      {creating && <Create me={me} onClose={() => setCreating(false)} notify={notify} created={(i) => { setCreating(false); setTick((t) => t + 1); setOpenId(i.id); }} />}
      {toast && <Toast {...toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { onLogin((await api('/auth/login', { method: 'POST', body: { email, password } })).data); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <div><div className="text-xs uppercase tracking-widest text-teal-800">Newtonite</div><h1 className="text-xl font-semibold">Operations Hub</h1></div>
        {err && <div role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{err}</div>}
        <div><label className="label" htmlFor="em">Email</label><input id="em" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="label" htmlFor="pw">Password</label><input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button className="btn btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-xs text-stone-500">Demo: manager.pay@newtonite.test / Password123!</p>
      </form>
    </div>
  );
}

function Dashboard({ go, open }: { go: (v: 'items', p?: Record<string, string>) => void; open: (id: string) => void }) {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); api('/dashboard/summary').then((r) => setD(r.data)).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  if (err) return <ErrorBox msg={err} onRetry={load} />;
  if (!d) return <Spinner />;
  const cards: [string, number, Record<string, string>][] = [
    ['Active items', d.totalActive, {}], ['Assigned to me', d.assignedToMe, { assignee: 'me' }], ['Critical', d.critical, { priority: 'Critical' }],
    ['High priority', d.high, { priority: 'High' }], ['Blocked', d.blocked, { status: 'Blocked' }], ['Overdue', d.overdue, { overdue: 'true' }],
  ];
  const List = ({ title, items, empty }: { title: string; items: Item[]; empty: string }) => (
    <section className="rounded-lg border bg-white"><h2 className="border-b px-4 py-3 text-sm font-semibold">{title}</h2>
      {!items.length ? <p className="p-4 text-sm text-stone-500">{empty}</p> : <ul className="divide-y">{items.map((i) => (
        <li key={i.id}><button className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-stone-50" onClick={() => open(i.id)}>
          <span className="min-w-0"><span className="font-mono text-xs text-stone-500">{i.key}</span> <span className="block truncate text-sm">{i.title}</span>
            <span className="text-xs text-stone-500">{i.assignee?.name ?? 'Unassigned'}{isOverdue(i) && <b className="ml-2 text-red-700">Overdue</b>}</span></span>
          <span className="flex shrink-0 flex-col items-end gap-1"><PriorityBadge v={i.priority} /><StatusBadge v={i.status} /></span></button></li>))}</ul>}
    </section>
  );
  const max = Math.max(1, ...Object.values<number>(d.byStatus));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{cards.map(([l, n, p]) => (
        <button key={l} onClick={() => go('items', p)} className="rounded-lg border bg-white p-4 text-left hover:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-600">
          <div className="text-2xl font-semibold">{n}</div><div className="text-xs text-stone-600">{l}</div></button>))}</div>
      <div className="grid gap-5 lg:grid-cols-2">
        <List title="Needs attention" items={d.needsAttention} empty="Nothing needs attention right now." />
        <div className="space-y-5">
          <section className="rounded-lg border bg-white p-4"><h2 className="mb-3 text-sm font-semibold">Work by status</h2>
            {Object.entries<number>(d.byStatus).map(([s, n]) => (
              <button key={s} onClick={() => go('items', { status: s })} className="mb-2 flex w-full items-center gap-3 text-left text-sm"><span className="w-24 shrink-0">{s}</span>
                <span className="h-3 flex-1 rounded bg-stone-100"><span className="block h-3 rounded bg-teal-700" style={{ width: `${(n / max) * 100}%` }} /></span><span className="w-8 text-right tabular-nums">{n}</span></button>))}
          </section>
          <List title="Recently updated" items={d.recent} empty="No work yet." />
        </div>
      </div>
    </div>
  );
}

function Items({ preset, tick, open }: { preset: Record<string, string>; tick: number; open: (id: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ sort: 'updatedAt', order: 'desc', ...preset });
  const [qIn, setQIn] = useState(preset.q ?? ''); const [page, setPage] = useState(1);
  const [res, setRes] = useState<{ data: Item[]; meta: any } | null>(null); const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => { api('/teams').then((r) => setTeams(r.data)).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(() => { setF((x) => ({ ...x, q: qIn })); setPage(1); }, 300); return () => clearTimeout(t); }, [qIn]); // debounce search
  useEffect(() => {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page), pageSize: '15' });
    let stale = false; setLoading(true); setErr('');
    api(`/work-items?${qs}`).then((r) => { if (!stale) setRes(r as any); }).catch((e) => !stale && setErr(e.message)).finally(() => !stale && setLoading(false));
    return () => { stale = true; }; // ignore out-of-order responses
  }, [f, page, tick]);
  const set = (k: string, v: string) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };
  const Sel = ({ k, label, opts }: { k: string; label: string; opts: (string | [string, string])[] }) => (
    <div><label className="label" htmlFor={`f-${k}`}>{label}</label>
      <select id={`f-${k}`} className="input" value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)}><option value="">All</option>
        {opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option>; })}</select></div>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 rounded-lg border bg-white p-3 md:grid-cols-4 xl:grid-cols-8">
        <div className="col-span-2"><label className="label" htmlFor="q">Search title, description or ID</label><input id="q" type="search" className="input" placeholder="e.g. refund or WI-1010" value={qIn} onChange={(e) => setQIn(e.target.value)} /></div>
        <Sel k="status" label="Status" opts={[...STATUSES]} /><Sel k="priority" label="Priority" opts={[...PRIORITIES]} /><Sel k="category" label="Category" opts={[...CATEGORIES]} />
        <Sel k="team" label="Team" opts={teams.map((t) => [t.id, t.name])} /><Sel k="assignee" label="Assignee" opts={[['me', 'Me'], ['unassigned', 'Unassigned']]} />
        <div><label className="label" htmlFor="sort">Sort</label><select id="sort" className="input" value={`${f.sort}:${f.order}`} onChange={(e) => { const [s, o] = e.target.value.split(':'); setF({ ...f, sort: s, order: o }); setPage(1); }}>
          <option value="updatedAt:desc">Recently updated</option><option value="createdAt:desc">Newest</option><option value="createdAt:asc">Oldest</option><option value="priority:desc">Priority (high→low)</option><option value="priority:asc">Priority (low→high)</option></select></div>
      </div>
      {f.overdue === 'true' && <div className="text-sm">Showing overdue items. <button className="underline" onClick={() => set('overdue', '')}>Clear</button></div>}
      <div className="overflow-x-auto rounded-lg border bg-white">
        {err ? <ErrorBox msg={err} /> : !res ? <Spinner /> : !res.data.length ? <p className="p-8 text-center text-sm text-stone-500">No work items match these filters.</p> : (
          <table className={`w-full text-sm ${loading ? 'opacity-60' : ''}`}>
            <thead className="border-b bg-stone-50 text-left text-xs uppercase text-stone-500"><tr><th className="px-3 py-2">ID</th><th>Title</th><th>Status</th><th>Priority</th><th className="hidden md:table-cell">Team</th><th className="hidden sm:table-cell">Assignee</th><th className="hidden lg:table-cell">Due</th><th className="hidden lg:table-cell">Updated</th></tr></thead>
            <tbody className="divide-y">{res.data.map((i) => (
              <tr key={i.id} className="hover:bg-stone-50"><td className="px-3 py-2 font-mono text-xs"><button className="underline" onClick={() => open(i.id)} aria-label={`Open ${i.key}`}>{i.key}</button></td>
                <td className="max-w-xs truncate"><button className="text-left hover:underline" onClick={() => open(i.id)}>{i.title}</button></td>
                <td><StatusBadge v={i.status} /></td><td><PriorityBadge v={i.priority} /></td><td className="hidden md:table-cell">{i.team.name}</td>
                <td className="hidden sm:table-cell">{i.assignee?.name ?? <span className="text-stone-400">Unassigned</span>}</td>
                <td className={`hidden lg:table-cell ${isOverdue(i) ? 'font-medium text-red-700' : ''}`}>{fmtDate(i.dueDate)}</td><td className="hidden whitespace-nowrap lg:table-cell">{fmt(i.updatedAt)}</td></tr>))}</tbody></table>)}
      </div>
      {res && res.meta.totalPages > 0 && <div className="flex items-center justify-between text-sm"><span>{res.meta.total} items · page {res.meta.page} of {res.meta.totalPages}</span>
        <span className="space-x-2"><button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="btn" disabled={page >= res.meta.totalPages} onClick={() => setPage(page + 1)}>Next</button></span></div>}
    </div>
  );
}

function Create({ me, onClose, notify, created }: { me: Me; onClose: () => void; notify: Notify; created: (i: Item) => void }) {
  const [teams, setTeams] = useState<Team[]>([]); const [users, setUsers] = useState<User[]>([]);
  const [f, setF] = useState({ title: '', description: '', category: 'Operations', priority: 'Medium', team: '', assignee: '', dueDate: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [idem] = useState(uuid); // one key per form instance: retrying after a timeout can never create a duplicate
  useEffect(() => { api('/teams').then((r) => { setTeams(r.data); setF((x) => ({ ...x, team: r.data[0]?.id ?? '' })); }); }, []);
  useEffect(() => { if (f.team) api(`/users?team=${f.team}`).then((r) => setUsers(r.data)); }, [f.team]);
  const canAssign = me.role !== 'member';
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api<Item>('/work-items', { method: 'POST', idem, body: { title: f.title, description: f.description, category: f.category, priority: f.priority, team: f.team, assignee: f.assignee || null, dueDate: f.dueDate || null } });
      notify(`Created ${r.data.key}`); created(r.data);
    } catch (x) { setErr(x instanceof ApiError && x.code === 'VALIDATION_ERROR' ? 'Please check the form: title needs 3+ characters.' : (x as Error).message); } finally { setBusy(false); }
  };
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="New work item" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-4">
        {err && <div role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{err}</div>}
        <div><label className="label" htmlFor="c-t">Title</label><input id="c-t" className="input" required minLength={3} maxLength={200} value={f.title} onChange={s('title')} /></div>
        <div><label className="label" htmlFor="c-d">Description</label><textarea id="c-d" rows={4} className="input" value={f.description} onChange={s('description')} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="c-c">Category</label><select id="c-c" className="input" value={f.category} onChange={s('category')}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div><label className="label" htmlFor="c-p">Priority</label><select id="c-p" className="input" value={f.priority} onChange={s('priority')}>{PRIORITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div><label className="label" htmlFor="c-tm">Team</label><select id="c-tm" className="input" value={f.team} onChange={s('team')} required>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
          <div><label className="label" htmlFor="c-du">Due date</label><input id="c-du" type="date" className="input" value={f.dueDate} onChange={s('dueDate')} /></div>
        </div>
        <div><label className="label" htmlFor="c-a">Assignee</label><select id="c-a" className="input" value={f.assignee} onChange={s('assignee')}><option value="">Unassigned</option>
          {users.filter((u) => canAssign || u.id === me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <button className="btn btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Create work item'}</button>
      </form>
    </Modal>
  );
}

function Detail({ id, me, onClose, notify, changed }: { id: string; me: Me; onClose: () => void; notify: Notify; changed: () => void }) {
  const [item, setItem] = useState<Item | null>(null); const [acts, setActs] = useState<any[]>([]); const [users, setUsers] = useState<User[]>([]);
  const [err, setErr] = useState(''); const [conflict, setConflict] = useState<Item | null>(null); const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ title: string; description: string; dueDate: string } | null>(null); const [comment, setComment] = useState('');
  const loadActs = useCallback(() => api(`/work-items/${id}/activity?pageSize=100`).then((r) => setActs(r.data)).catch(() => {}), [id]);
  const load = useCallback(() => {
    setErr(''); api<Item>(`/work-items/${id}`).then((r) => { setItem(r.data); api(`/users?team=${r.data.team._id}`).then((u) => setUsers(u.data)); }).catch((e) => setErr(e.message)); loadActs();
  }, [id, loadActs]);
  useEffect(load, [load]);
  if (err) return <Modal title="Work item" onClose={onClose} wide><ErrorBox msg={err} onRetry={load} /></Modal>;
  if (!item) return <Modal title="Work item" onClose={onClose} wide><Spinner /></Modal>;

  const priv = me.role === 'admin' || (me.role === 'manager' && me.teamIds.includes(item.team._id));
  const mine = item.assignee?._id === me.id;
  /** Run a mutation; the UI only updates from the server's confirmed response. 409 => show latest, never overwrite. */
  const run = async (fn: () => Promise<{ data: Item }>, ok: string) => {
    setBusy(true);
    try { const r = await fn(); setItem(r.data); setConflict(null); setEdit(null); notify(ok); changed(); loadActs(); }
    catch (x) {
      if (x instanceof ApiError && x.status === 409 && x.code === 'VERSION_CONFLICT') { setConflict(x.details.current); notify('Someone else changed this item first', 'err'); }
      else notify((x as Error).message, 'err');
    } finally { setBusy(false); }
  };
  const patch = (body: object, ok: string) => run(() => api<Item>(`/work-items/${id}`, { method: 'PATCH', body: { version: item.version, ...body } }), ok);
  const assign = (assignee: string | null) => run(() => api<Item>(`/work-items/${id}/assign`, { method: 'POST', idem: uuid(), body: { assignee, version: item.version } }), 'Assignment updated');
  const addComment = async (e: FormEvent) => {
    e.preventDefault(); if (!comment.trim()) return;
    try { await api(`/work-items/${id}/comments`, { method: 'POST', body: { body: comment } }); setComment(''); loadActs(); } catch (x) { notify((x as Error).message, 'err'); }
  };
  const describe = (a: any) => {
    const b = a.before ?? {}, f = a.after ?? {};
    switch (a.action) {
      case 'created': return 'created this item';
      case 'status_changed': return `changed status ${b.status} → ${f.status}`;
      case 'priority_changed': return `changed priority ${b.priority} → ${f.priority}`;
      case 'assigned': { const n = (v: string | null) => (v ? users.find((u) => u.id === v)?.name ?? 'a teammate' : 'nobody'); return `reassigned ${n(b.assignee)} → ${n(f.assignee)}`; }
      case 'updated': return `edited ${Object.keys(f).join(', ')}`;
      default: return a.action;
    }
  };
  const allowed = TRANSITIONS[item.status].filter((s) => priv || (s !== 'Resolved' && item.status !== 'Resolved'));
  const canEditFields = priv || mine || item.reporter._id === me.id;
  const canChangeStatus = priv || mine;
  const canAssignOthers = priv;
  return (
    <Modal title={item.key} onClose={onClose} wide>
      <div className="space-y-5 p-4">
        {conflict && (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <b>This item changed while you were viewing it.</b> Your change was not applied. Latest: v{conflict.version}, {conflict.status}, {conflict.priority}, {conflict.assignee?.name ?? 'unassigned'}.
            <button className="btn ml-2" onClick={() => { setItem(conflict); setConflict(null); setEdit(null); loadActs(); changed(); }}>Load latest and retry</button>
          </div>)}
        <div>
          {edit ? (
            <div className="space-y-3">
              <div><label className="label" htmlFor="e-t">Title</label><input id="e-t" className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
              <div><label className="label" htmlFor="e-d">Description</label><textarea id="e-d" rows={4} className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
              <div><label className="label" htmlFor="e-du">Due date</label><input id="e-du" type="date" className="input" value={edit.dueDate} onChange={(e) => setEdit({ ...edit, dueDate: e.target.value })} /></div>
              <div className="space-x-2"><button className="btn btn-primary" disabled={busy} onClick={() => patch({ title: edit.title, description: edit.description, dueDate: edit.dueDate || null }, 'Saved')}>Save</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold">{item.title}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700">{item.description || <i className="text-stone-400">No description</i>}</p>
              {canEditFields && <button className="btn mt-3" onClick={() => setEdit({ title: item.title, description: item.description, dueDate: item.dueDate?.slice(0, 10) ?? '' })}>Edit details</button>}
            </>)}
        </div>
        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-stone-50 p-3 text-sm sm:grid-cols-3">
          <div><dt className="label">Team</dt><dd>{item.team.name}</dd></div><div><dt className="label">Category</dt><dd>{item.category}</dd></div>
          <div><dt className="label">Reporter</dt><dd>{item.reporter.name}</dd></div><div><dt className="label">Due</dt><dd className={isOverdue(item) ? 'font-medium text-red-700' : ''}>{fmtDate(item.dueDate)}{isOverdue(item) && ' (overdue)'}</dd></div>
          <div><dt className="label">Created</dt><dd>{fmt(item.createdAt)}</dd></div><div><dt className="label">Version</dt><dd>v{item.version}</dd></div>
        </dl>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor="d-s">Status</label>
            <select id="d-s" className="input" disabled={busy || !canChangeStatus} value={item.status} onChange={(e) => patch({ status: e.target.value }, `Status: ${e.target.value}`)}>
              <option>{item.status}</option>{allowed.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div><label className="label" htmlFor="d-p">Priority</label>
            <select id="d-p" className="input" disabled={busy || !priv} value={item.priority} onChange={(e) => patch({ priority: e.target.value }, `Priority: ${e.target.value}`)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></div>
          <div><label className="label" htmlFor="d-a">Assignee</label>
            <select id="d-a" className="input" disabled={busy || !canAssignOthers} value={item.assignee?._id ?? ''} onChange={(e) => assign(e.target.value || null)}>
              <option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        </div>
        {!priv && <div className="flex gap-2">{!item.assignee && <button className="btn btn-primary" disabled={busy} onClick={() => assign(me.id)}>Take this item</button>}{mine && <button className="btn" disabled={busy} onClick={() => assign(null)}>Release</button>}</div>}
        <section aria-label="Activity"><h3 className="mb-2 text-sm font-semibold">Activity & comments</h3>
          <ol className="space-y-3 border-l-2 border-stone-200 pl-4">{acts.map((a) => (
            <li key={a.id} className="text-sm">{a.action === 'comment'
              ? <div className="rounded-md border bg-white p-2.5"><div className="text-xs text-stone-500"><b className="text-stone-800">{a.actor.name}</b> commented · {fmt(a.createdAt)}</div><p className="mt-1 whitespace-pre-wrap">{a.message}</p></div>
              : <div><b>{a.actor.name}</b> {describe(a)} <span className="text-xs text-stone-500">· {fmt(a.createdAt)}</span></div>}</li>))}</ol>
          <form onSubmit={addComment} className="mt-4"><label className="label" htmlFor="cm">Add a comment</label><textarea id="cm" rows={3} className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="btn btn-primary mt-2" disabled={!comment.trim()}>Comment</button></form>
        </section>
      </div>
    </Modal>
  );
}
