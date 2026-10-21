import mongoose from 'mongoose';
import { buildApp } from './app.js';
import { config } from './lib.js';
mongoose.set('bufferTimeoutMS', 5000);
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
await mongoose.syncIndexes();
buildApp().listen(config.port, () => console.log(`API listening on :${config.port} (transactions: ${config.useTx})`));
