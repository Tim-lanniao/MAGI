import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect,it,vi } from 'vitest';
import { aliUpdater,stableIPv6,syncRecord } from '../../deploy/ddns/update.mjs';
const { default: AliDnsClient } = createRequire(import.meta.url)('@alicloud/alidns20150109');

it('IPv6 只选择指定接口上稳定、全局、可用的 secured 地址', () => {
  expect(stableIPv6([
    ' inet6 fe80::1%en0 prefixlen 64 secured', ' inet6 fd00::123 prefixlen 64 secured',
    ' inet6 2001:db8::100 prefixlen 64 autoconf temporary',
    ' inet6 2001:db8::101 prefixlen 64 autoconf secured deprecated',
    ' inet6 2001:0db8:0000::102 prefixlen 64 autoconf secured',
  ].join('\n'))).toBe('2001:db8::102');
  expect(() => stableIPv6(' inet6 2001:db8::101 prefixlen 64 temporary')).toThrow('NO_STABLE_GLOBAL_IPV6');
});
it('缓存跨运行生效，IP 变化触发更新，失败的更新在下一周期重试', async () => {
  const dir = await mkdtemp(join(tmpdir(),'magi-ddns-'));
  try {
    const cache = join(dir,'A.cache');
    const update = vi.fn(async () => {});
    await syncRecord('A','192.0.2.1',cache,update);
    expect(await syncRecord('A','192.0.2.1',cache,update)).toBe(false);
    update.mockRejectedValueOnce(new Error('DNS unavailable'));
    await expect(syncRecord('A','192.0.2.2',cache,update)).rejects.toThrow();
    await syncRecord('A','192.0.2.2',cache,update);
    expect(update.mock.calls).toHaveLength(3);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

it('阿里云 SDK 仅修改本域默认线路的唯一记录，沿用 TTL', async () => {
  const row = { RR:'magi',type:'AAAA',status:'ENABLE',line:'default',value:'2001:db8::1',TTL:600,recordId:'test-record' };
  const lookup = vi.spyOn(AliDnsClient.prototype,'describeDomainRecords')
    .mockResolvedValue({body:{totalCount:1,domainRecords:{record:[row]}}} as any);
  const write = vi.spyOn(AliDnsClient.prototype,'updateDomainRecord').mockResolvedValue({} as any);
  try {
    const update = aliUpdater({DDNS_DOMAIN:'lanthan.cn',DDNS_RECORD:'magi',DDNS_API_ID:'test',DDNS_API_SECRET:'test'});
    await update('AAAA','2001:db8::1');
    expect(write).not.toHaveBeenCalled();
    await update('AAAA','2001:db8::2');
    expect(lookup.mock.calls[0][0]).toMatchObject({domainName:'lanthan.cn',RRKeyWord:'magi',line:'default',searchMode:'COMBINATION'});
    expect(write.mock.calls[0][0]).toMatchObject({RR:'magi',type:'AAAA',recordId:'test-record',TTL:600,value:'2001:db8::2'});
    lookup.mockResolvedValueOnce({body:{totalCount:2,domainRecords:{record:[row,row]}}} as any);
    await expect(update('AAAA','2001:db8::3')).rejects.toThrow('EXPECTED_ONE_ENABLED_RECORD');
    expect(write).toHaveBeenCalledTimes(1);
  } finally { lookup.mockRestore(); write.mockRestore(); }
});
