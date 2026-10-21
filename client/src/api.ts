export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idem?: string } = {}): Promise<{ data: T; meta?: any }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET', credentials: 'same-origin',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.idem ? { 'Idempotency-Key': opts.idem } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch { throw new ApiError(0, 'NETWORK', 'Network error — check your connection. Your request may or may not have been processed; retrying is safe.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'ERROR', json.error?.message ?? `Request failed (${res.status})`, json.error?.details);
  return json;
}
export const uuid = () => crypto.randomUUID();

export const STATUSES = ['Open', 'In Progress', 'Blocked', 'In Review', 'Resolved'] as const;
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export const CATEGORIES = ['Engineering', 'Customer Support', 'Payments', 'Operations', 'Compliance'] as const;
export const TRANSITIONS: Record<string, string[]> = {
  Open: ['In Progress', 'Blocked'], 'In Progress': ['Open', 'Blocked', 'In Review'], Blocked: ['Open', 'In Progress'],
  'In Review': ['In Progress', 'Resolved'], Resolved: ['Open'],
};
export type Me = { id: string; name: string; email: string; role: 'admin' | 'manager' | 'member'; teamIds: string[] };
export type Item = {
  id: string; key: string; title: string; description: string; category: string; status: string; priority: string;
  reporter: { _id: string; name: string }; assignee: { _id: string; name: string } | null; team: { _id: string; name: string };
  dueDate: string | null; version: number; createdAt: string; updatedAt: string;
};
