import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Activity, CATEGORIES, config, Counter, Idem, PRIORITIES, priorityRank, Session, STATUSES, Team, User, WorkItem } from './lib.js';

const uri = process.env.SEED_URI ?? config.mongoUri;
await mongoose.connect(uri);
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed in production');
await mongoose.connection.dropDatabase();
await Promise.all([User, Team, WorkItem, Activity, Counter, Idem, Session].map((m) => m.syncIndexes()));

const PASSWORD = 'Password123!';
const passwordHash = await bcrypt.hash(PASSWORD, 10);
const teams = await Team.insertMany([
  { name: 'Payments Operations', key: 'PAY' }, { name: 'Platform Engineering', key: 'ENG' },
  { name: 'Customer Care', key: 'CC' }, { name: 'Compliance', key: 'CMP' },
]);
const [pay, eng, cc, cmp] = teams.map((t) => t._id);
const mk = (name: string, email: string, role: string, teamIds: any[]) => ({ name, email, role, teamIds, passwordHash });
const users = await User.insertMany([
  mk('Ada Admin', 'admin@newtonite.test', 'admin', [pay, eng, cc, cmp]),
  mk('Maya Manager', 'manager.pay@newtonite.test', 'manager', [pay, cmp]),
  mk('Eli Manager', 'manager.eng@newtonite.test', 'manager', [eng]),
  mk('Priya Payments', 'member.pay@newtonite.test', 'member', [pay]),
  mk('Sam Payments', 'member.pay2@newtonite.test', 'member', [pay]),
  mk('Noor Engineer', 'member.eng@newtonite.test', 'member', [eng]),
  mk('Carl Care', 'member.cc@newtonite.test', 'member', [cc]),
]);
const byTeam = (t: any) => users.filter((u) => u.role !== 'admin' && u.teamIds.some((x) => String(x) === String(t)));
const rnd = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const titles = ['Refund stuck in pending', 'Duplicate settlement batch', 'Checkout latency spike', 'Chargeback evidence request', 'KYC review backlog', 'Webhook retries failing', 'Customer cannot reset password', 'Audit log export request', 'Reconciliation mismatch', 'Fraud rule tuning', 'Vendor payout delayed', 'SLA breach on premium tickets'];
const N = 150;
const docs = Array.from({ length: N }, (_, i) => {
  const team = rnd(teams), members = byTeam(team._id), reporter = rnd(members);
  const priority = rnd(PRIORITIES), status = rnd(STATUSES);
  const created = new Date(Date.now() - Math.random() * 20 * 864e5);
  return {
    key: `WI-${1001 + i}`, title: `${rnd(titles)} #${i + 1}`, description: 'Seeded demo item requiring investigation and follow-up by the owning team.',
    category: rnd(CATEGORIES), status, priority, priorityRank: priorityRank(priority), team: team._id, reporter: reporter._id,
    assignee: Math.random() < 0.7 ? rnd(members)._id : null,
    dueDate: Math.random() < 0.6 ? new Date(Date.now() + (Math.random() * 14 - 5) * 864e5) : null,
    createdAt: created, updatedAt: new Date(created.getTime() + Math.random() * 5 * 864e5),
  };
});
const items = await WorkItem.insertMany(docs);
await Activity.insertMany(items.map((it) => ({ item: it._id, actor: it.reporter, action: 'created', message: 'Created work item', createdAt: (it as any).createdAt })));
await Counter.create({ _id: 'workItem', seq: N + 1 });
console.log(`Seeded ${users.length} users, ${teams.length} teams, ${items.length} items. Password for all demo users: ${PASSWORD}`);
await mongoose.disconnect();
