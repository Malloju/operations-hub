import mongoose from 'mongoose';
// Initiates a single-node replica set (needed for transactions). Idempotent.
const host = process.env.MONGO_HOST ?? '127.0.0.1:27017';
await mongoose.connect(`mongodb://${host}/admin?directConnection=true`);
try {
  await mongoose.connection.db!.admin().command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] } });
  console.log('Replica set initiated');
} catch (e: any) {
  console.log('replSetInitiate:', e.codeName ?? e.message);
}
await mongoose.disconnect();
