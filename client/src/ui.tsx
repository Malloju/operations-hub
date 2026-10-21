import { ReactNode, useEffect } from 'react';
const PRI: Record<string, string> = { Critical: 'bg-red-100 text-red-800 ring-red-200', High: 'bg-orange-100 text-orange-800 ring-orange-200', Medium: 'bg-amber-50 text-amber-800 ring-amber-200', Low: 'bg-stone-100 text-stone-600 ring-stone-200' };
const STA: Record<string, string> = { Open: 'bg-sky-50 text-sky-800 ring-sky-200', 'In Progress': 'bg-indigo-50 text-indigo-800 ring-indigo-200', Blocked: 'bg-red-50 text-red-800 ring-red-200', 'In Review': 'bg-violet-50 text-violet-800 ring-violet-200', Resolved: 'bg-emerald-50 text-emerald-800 ring-emerald-200' };
const pill = 'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ';
export const PriorityBadge = ({ v }: { v: string }) => <span className={pill + PRI[v]}>{v}</span>;
export const StatusBadge = ({ v }: { v: string }) => <span className={pill + STA[v]}>{v}</span>;
export const Spinner = () => <div role="status" className="p-6 text-center text-sm text-stone-500">Loading…</div>;
export const ErrorBox = ({ msg, onRetry }: { msg: string; onRetry?: () => void }) => (
  <div role="alert" className="m-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{msg} {onRetry && <button className="ml-2 underline" onClick={onRetry}>Retry</button>}</div>
);
export const isOverdue = (i: { dueDate: string | null; status: string }) => !!i.dueDate && i.status !== 'Resolved' && new Date(i.dueDate) < new Date();
export const fmt = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

export function Toast({ msg, kind, onDone }: { msg: string; kind: 'ok' | 'err'; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [msg]);
  return <div role="status" aria-live="polite" className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-md px-4 py-2 text-sm text-white shadow-lg ${kind === 'ok' ? 'bg-teal-800' : 'bg-red-700'}`}>{msg}</div>;
}
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`h-full w-full overflow-y-auto bg-white shadow-xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-4 py-3"><h2 className="font-semibold">{title}</h2><button className="btn" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}
