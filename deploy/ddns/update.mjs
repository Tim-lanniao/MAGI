import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { default: AliDnsClient, DescribeDomainRecordsRequest, UpdateDomainRecordRequest } = require('@alicloud/alidns20150109');
const { $OpenApiUtil } = require('@alicloud/openapi-core');

export function stableIPv6(output) {
  for (const line of output.split('\n')) {
    const match = /^\s*inet6\s+([0-9a-f:]+)\s/i.exec(line);
    if (match && /^[23]/i.test(match[1]) && isIP(match[1]) === 6 && /\bsecured\b/.test(line)
      && !/\b(temporary|deprecated|tentative|duplicated|detached)\b/.test(line)) return canonical(match[1]);
  }
  throw new Error('NO_STABLE_GLOBAL_IPV6');
}
function canonical(ip) {
  return isIP(ip) === 6 ? new URL('http://[' + ip + ']').hostname.slice(1,-1) : ip;
}
async function address(type, env) {
  if (type === 'A') {
    const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('IPV4_LOOKUP_FAILED');
    const { ip } = await response.json();
    if (isIP(ip) !== 4) throw new Error('INVALID_IPV4');
    return ip;
  }
  const iface = env.DDNS_INTERFACE || /^\s*interface:\s*(\S+)/m.exec(
    execFileSync('/sbin/route',['-n','get','-inet6','default'],{ encoding: 'utf8', timeout: 5000 }))?.[1];
  if (!iface || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(iface)) throw new Error('NO_IPV6_INTERFACE');
  return stableIPv6(execFileSync('/sbin/ifconfig',[iface],{ encoding: 'utf8', timeout: 5000 }));
}
export function aliUpdater(env) {
  const client = new AliDnsClient(new $OpenApiUtil.Config({
    accessKeyId: env.DDNS_API_ID, accessKeySecret: env.DDNS_API_SECRET, endpoint: 'alidns.aliyuncs.com',
    connectTimeout: 10000, readTimeout: 15000,
  }));
  return async (type, ip) => {
    const domainName = env.DDNS_DOMAIN;
    const rr = env.DDNS_RECORD;
    const query = new DescribeDomainRecordsRequest({
      domainName, RRKeyWord: rr, type, line: 'default', searchMode: 'COMBINATION', pageSize: 5,
    });
    const { body } = await client.describeDomainRecords(query);
    const records = (body.domainRecords?.record ?? []).filter(r =>
      r.RR === rr && r.type === type && r.line === 'default' && r.status === 'ENABLE');
    if (body.totalCount !== 1 || records.length !== 1) throw new Error('EXPECTED_ONE_ENABLED_RECORD');
    const record = records[0];
    if (canonical(record.value) !== ip) await client.updateDomainRecord(new UpdateDomainRecordRequest({
      recordId: record.recordId, RR: rr, type, line: record.line, value: ip, TTL: record.TTL,
    }));
  };
}
export async function syncRecord(type, ip, cacheFile, update) {
  let cached;
  try { cached = (await readFile(cacheFile,'utf8')).trim(); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (cached === ip) return false;
  await update(type,ip);
  const temp = cacheFile + '.' + process.pid + '.tmp';
  await writeFile(temp,ip + '\n',{ mode: 0o600 });
  await rename(temp,cacheFile);
  return true;
}
async function main() {
  process.umask(0o077);
  if (existsSync('.env')) {
    if (process.platform !== 'win32' && (statSync('.env').mode & 0o077)) throw new Error('ENV_PERMISSIONS');
    process.loadEnvFile('.env');
  }
  const env = process.env;
  if (env.DDNS_PROVIDER !== 'alidns' || !env.DDNS_API_ID || !env.DDNS_API_SECRET ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(env.DDNS_DOMAIN ?? '') ||
      !/^[a-z0-9-]+$/.test(env.DDNS_RECORD ?? '')) throw new Error('DDNS_CONFIG');
  const dir = join(homedir(),'Library','Application Support','MAGI','ddns');
  await mkdir(dir,{ recursive: true, mode: 0o700 });
  const update = aliUpdater(env);
  for (const [type, flag] of [['A',env.DDNS_IPV4],['AAAA',env.DDNS_IPV6]]) {
    if (flag === 'false') continue;
    if (flag !== 'true') throw new Error('DDNS_CONFIG');
    try {
      const ip = await address(type,env);
      const changed = await syncRecord(type,ip,join(dir,[env.DDNS_PROVIDER,env.DDNS_RECORD,env.DDNS_DOMAIN,type].join('.') + '.cache'),update);
      if (changed) console.log(new Date().toISOString(),type,'记录已核对');
    } catch (err) {
      // SDK errors may contain signed requests. Only emit a short diagnostic code.
      const code = err.code ?? err.message;
      console.error(type, /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : 'DDNS_UPDATE_FAILED');
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(err => { console.error(/^[A-Z_]+$/.test(err.message) ? err.message : 'DDNS_FAILED'); process.exitCode = 1; });
}
