import { parseArgs } from 'node:util';
import { cliConfig, loadEnvironment } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createInvite } from '../src/auth/invite.js';

process.umask(0o077);
const { values } = parseArgs({ options: { ip: { type: 'string' } } });
loadEnvironment();
const config = cliConfig();
const db = openDb(config.DB_PATH);
try { console.log('https://' + config.RP_ID + '/setup?token=' + createInvite(db, values.ip)); }
finally { db.close(); }
