import 'dotenv/config';
import mongoose, { Schema, ClientSession, Types } from 'mongoose';

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16 && !s.startsWith('change-me')) return s;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return 'test-only-secret-not-used-elsewhere';
  throw new Error('JWT_SECRET must be a real random value (>=16 chars, not the .env.example placeholder). See README setup.');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/newtonite?replicaSet=rs0&directConnection=true',
  jwtSecret: jwtSecret(),
  useTx: (process.env.USE_TRANSACTIONS ?? 'true') !== 'false',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};

export const STATUSES = ['Open', 'In Progress', 'Blocked', 'In Review', 'Resolved'] as const;
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export const CATEGORIES = ['Engineering', 'Customer Support', 'Payments', 'Operations', 'Compliance'] as const;
export const ROLES = ['admin', 'manager', 'member'] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export const priorityRank = (p: Priority) => PRIORITIES.indexOf(p) + 1;

/** Allowed workflow transitions. Resolved is only reachable from In Review. */
export const TRANSITIONS: Record<Status, Status[]> = {
  Open: ['In Progress', 'Blocked'],
  'In Progress': ['Open', 'Blocked', 'In Review'],
  Blocked: ['Open', 'In Progress'],
  'In Review': ['In Progress', 'Resolved'],
  Resolved: ['Open'], // reopen
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

const opts = { versionKey: false } as const;

export const User = mongoose.model('User', new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true },
  teamIds: [{ type: Schema.Types.ObjectId, ref: 'Team' }],
  active: { type: Boolean, default: true },
}, { ...opts, timestamps: true }));

/** One row per login. JWT carries the row id (jti); deleting the row revokes that session immediately. TTL matches token lifetime. */
export const Session = mongoose.model('Session', new Schema({
  _id: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 8 * 3600 },
}, opts));

export const Team = mongoose.model('Team', new Schema({
  name: { type: String, required: true, unique: true },
  key: { type: String, required: true, unique: true },
}, opts));

const itemSchema = new Schema({
  key: { type: String, required: true, unique: true }, // human id, e.g. WI-1042
  title: { type: String, required: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 10000 },
  category: { type: String, enum: CATEGORIES, required: true },
  status: { type: String, enum: STATUSES, default: 'Open' },
  priority: { type: String, enum: PRIORITIES, default: 'Medium' },
  priorityRank: { type: Number, required: true }, // denormalised so priority sort is index-friendly
  reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  assignee: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  team: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
  dueDate: { type: Date, default: null },
  version: { type: Number, default: 1 }, // optimistic concurrency token
}, { ...opts, timestamps: true });
itemSchema.index({ team: 1, status: 1, priorityRank: -1, updatedAt: -1 });
itemSchema.index({ assignee: 1, status: 1, updatedAt: -1 });
itemSchema.index({ status: 1, dueDate: 1 });
itemSchema.index({ updatedAt: -1 });
itemSchema.index({ createdAt: -1 });
itemSchema.index({ title: 'text', description: 'text' });
export const WorkItem = mongoose.model('WorkItem', itemSchema);

const actSchema = new Schema({
  item: { type: Schema.Types.ObjectId, ref: 'WorkItem', required: true },
  actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true }, // created|updated|status_changed|priority_changed|assigned|comment
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  message: String,
  createdAt: { type: Date, default: Date.now },
}, opts);
actSchema.index({ item: 1, createdAt: 1, _id: 1 });
export const Activity = mongoose.model('Activity', actSchema);

const idemSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  scope: String, hash: String, response: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }, // TTL 24h
}, opts);
idemSchema.index({ userId: 1, key: 1 }, { unique: true });
export const Idem = mongoose.model('IdempotencyKey', idemSchema);

export const Counter = mongoose.model('Counter', new Schema({ _id: String, seq: Number }, opts));

/** Run fn in a transaction (or without, if USE_TRANSACTIONS=false — documented weaker mode). */
export async function tx<T>(fn: (s?: ClientSession) => Promise<T>): Promise<T> {
  if (!config.useTx) return fn(undefined);
  const s = await mongoose.startSession();
  try { let r!: T; await s.withTransaction(async () => { r = await fn(s); }); return r; }
  finally { await s.endSession(); }
}

export const oid = (v: string) => (Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null);
