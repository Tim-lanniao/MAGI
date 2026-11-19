import { getDomain } from 'tldts';
import type { Vote } from './schema.js';

export function pageUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length > 4096 || !/^https?:\/\//i.test(raw) || /[\s\\]/u.test(raw)) return null;
  const url = URL.parse(raw);
  return url && url.hostname && !url.username && !url.password ? url : null;
}

// Match a cited page to the provider's URL without mistaking a different article for it.
export function pageKey(raw: string): string | null {
  const url = pageUrl(raw);
  if (!url) return null;
  url.hash = '';
  url.hostname = url.hostname.replace(/\.$/, '');
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.*|gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function citedSites(votes: Vote[], voter: 'gpt' | 'deepseek') {
  const vote = votes.find(v => v.voter === voter);
  if (vote?.state !== 'valid') return new Set<string>();
  return new Set(vote.sources.map(({ url }) => {
    const host = new URL(url).hostname.replace(/\.$/, '');
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  }));
}

export function compareSources(votes: Vote[]) {
  const gpt = citedSites(votes, 'gpt');
  const deepseek = citedSites(votes, 'deepseek');
  if (!gpt.size || !deepseek.size) return null;
  const sharedSites = [...gpt].filter(site => deepseek.has(site)).sort();
  const totalSites = gpt.size + deepseek.size - sharedSites.length;
  const score = sharedSites.length / totalSites;
  return { sharedSites, totalSites, score, warning: score >= 2 / 3 ? '两方信源重叠，独立性低' : null };
}
