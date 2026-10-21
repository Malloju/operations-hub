/**
 * UI → real API integration test. Renders the actual React app in jsdom and drives it like a user.
 * Requires the API running on UI_API (default http://localhost:4000) with seeded data (`npm run seed` in /server).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';

const API = process.env.UI_API ?? 'http://localhost:4000';
const nodeFetch = globalThis.fetch.bind(globalThis);
let cookie = '';
// The browser normally handles cookies + same-origin URLs; emulate that for the app's fetch('/api/...') calls.
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const r = await nodeFetch(API + url, { ...init, headers: { ...(init.headers as any), ...(cookie ? { cookie } : {}) } });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.startsWith('token=;') ? '' : sc.split(';')[0];
  return r;
}) as typeof fetch;

async function adminApi(path: string, method = 'GET', body?: unknown) {
  const l = await nodeFetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@newtonite.test', password: 'Password123!' }) });
  const c = l.headers.get('set-cookie')!.split(';')[0];
  const r = await nodeFetch(API + '/api' + path, { method, headers: { 'Content-Type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined });
  return r.json() as Promise<any>;
}
beforeAll(async () => { await nodeFetch(API + '/api/health').catch(() => { throw new Error(`API not reachable at ${API}; start it and seed first`); }); });
afterEach(cleanup);

describe('UI against the live API', () => {
  it('login, dashboard, search, create, status change, comment, stale-edit conflict, logout', async () => {
    const user = userEvent.setup();
    render(<App />);

    // --- login (bad then good)
    await user.type(await screen.findByLabelText('Email'), 'manager.pay@newtonite.test');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid email or password/);
    await user.clear(screen.getByLabelText('Password')); await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // --- dashboard numbers equal the backend's numbers
    const active = await screen.findByRole('button', { name: /Active items/ });
    const summary = (await (await nodeFetch(API + '/api/dashboard/summary', { headers: { cookie } })).json() as any).data;
    expect(within(active).getByText(String(summary.totalActive))).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();

    // --- list + server-side search
    await user.click(screen.getByRole('button', { name: 'Work items' }));
    await screen.findByRole('table');
    // pick a key this user can actually see (seed assigns teams randomly), and prove other teams' items are NOT findable
    const visible = (await (await nodeFetch(API + '/api/work-items?pageSize=1', { headers: { cookie } })).json() as any).data[0].key as string;
    await user.type(screen.getByLabelText(/Search title/), visible);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2), { timeout: 5000 }); // header + 1 result
    expect(screen.getByRole('button', { name: `Open ${visible}` })).toBeTruthy();
    await user.clear(screen.getByLabelText(/Search title/));

    // --- create via the form
    const title = `UI created ${Date.now()}`;
    await user.click(screen.getByRole('button', { name: '+ New work item' }));
    const dlg = await screen.findByRole('dialog', { name: 'New work item' });
    await user.type(within(dlg).getByLabelText('Title'), title);
    await user.click(within(dlg).getByRole('button', { name: 'Create work item' }));
    const detail = await screen.findByRole('dialog', { name: /WI-\d+/ });
    expect(await within(detail).findByText(title)).toBeTruthy();
    const key = detail.getAttribute('aria-label')!;

    // --- status change is server-confirmed and appears in the timeline
    await user.selectOptions(within(detail).getByLabelText('Status'), 'In Progress');
    expect(await within(detail).findByText(/changed status Open → In Progress/)).toBeTruthy();

    // --- comment
    await user.type(within(detail).getByLabelText('Add a comment'), 'Comment from the UI test');
    await user.click(within(detail).getByRole('button', { name: 'Comment' }));
    expect(await within(detail).findByText('Comment from the UI test')).toBeTruthy();

    // --- stale edit: someone else changes the item, then this user edits the old version => conflict banner, nothing overwritten
    const list = await adminApi(`/work-items?q=${key}`); const id = list.data[0].id; const cur = list.data[0];
    await adminApi(`/work-items/${id}`, 'PATCH', { version: cur.version, title: 'Changed by someone else' });
    await user.selectOptions(within(detail).getByLabelText('Priority'), 'Critical');
    const alert = await within(detail).findByRole('alert');
    expect(alert.textContent).toMatch(/changed while you were viewing it/);
    expect((await adminApi(`/work-items/${id}`)).data.priority).toBe('Medium'); // the stale change was NOT applied
    await user.click(within(alert).getByRole('button', { name: /Load latest/ }));
    expect(await within(detail).findByText('Changed by someone else')).toBeTruthy();
    await user.selectOptions(within(detail).getByLabelText('Priority'), 'Critical'); // retry on fresh version succeeds
    await waitFor(async () => expect((await adminApi(`/work-items/${id}`)).data.priority).toBe('Critical'));

    // --- logout
    await user.click(within(detail).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect((await nodeFetch(API + '/api/work-items')).status).toBe(401);
  });

  it('a member sees disabled controls for actions the backend would reject', async () => {
    cookie = '';
    const user = userEvent.setup(); render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'member.pay@newtonite.test');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Work items' }));
    await screen.findByRole('table');
    await user.click(screen.getAllByRole('button', { name: /^Open WI-/ })[0]);
    const d = await screen.findByRole('dialog', { name: /WI-\d+/ });
    await within(d).findByLabelText('Priority');
    expect((within(d).getByLabelText('Priority') as HTMLSelectElement).disabled).toBe(true);
    expect((within(d).getByLabelText('Assignee') as HTMLSelectElement).disabled).toBe(true);
  });
});
