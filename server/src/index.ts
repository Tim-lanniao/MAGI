import { loadEnvironment, readConfig } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';

process.umask(0o077);
loadEnvironment();
const config = readConfig();
const db = openDb(config.DB_PATH);
const { app, runner } = await buildApp(config,db);
try {
  await app.listen({ host: '127.0.0.1', port: config.PORT });
  runner.recover();
} catch (err) {
  await app.close();
  db.close();
  throw err;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  db.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
