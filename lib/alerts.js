// Urgent-issue detection. Runs after each Search Console sync and each site scan.
// Writes to the alerts table (deduplicated); a daily email goes out only if there's something new and urgent.
const { db } = require('./shared');

const KEY_PAGES = ['/', '/collections/pram-hire', '/collections/travel-prams', '/collections/pram-hire-london', '/collections/double-prams',
  '/collections/off-road-prams', '/collections/all-terrain-prams', '/collections/city-prams', '/collections/running-prams',
  '/collections/cribs', '/collections/cots', '/collections/carriers', '/collections/travel'];
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(new Date(d).getTime() + n * 864e5));

async function raise(a) {
  const { error } = await db.from('alerts').insert(a);
  if (error && !/duplicate/i.test(error.message)) throw new Error('alerts: ' + error.message);
}

async function trafficAlerts() {
  const { data: last } = await db.from('gsc_site_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
  if (!last) return;
  const d = last.date;
  const { data: site } = await db.from('gsc_site_daily').select('date,clicks').gte('date', addDays(d, -7)).lte('date', d).order('date');
  const today = (site || []).find((r) => r.date === d);
  const prev = (site || []).filter((r) => r.date < d);
  const avg = prev.length ? prev.reduce((a, r) => a + r.clicks, 0) / prev.length : 0;
  if (today && avg >= 50 && today.clicks < avg * 0.6) {
    await raise({ date: d, severity: 'urgent', kind: 'traffic_drop', title: `Google clicks fell ${Math.round((1 - today.clicks / avg) * 100)}% on ${d}`, detail: `${today.clicks} clicks vs a 7-day average of ${Math.round(avg)}. Check for a site problem (page down, theme change, noindex) or a Google update.`, dedupe_key: `traffic_drop|${d}` });
  }

  // key pages: last 3 days vs the 14 days before
  const { data: rows } = await db.from('gsc_page_daily').select('date,page,clicks,impressions,position').in('page', KEY_PAGES).gte('date', addDays(d, -16)).lte('date', d);
  for (const p of KEY_PAGES) {
    const r = (rows || []).filter((x) => x.page === p);
    const recent = r.filter((x) => x.date > addDays(d, -3)), base = r.filter((x) => x.date <= addDays(d, -3));
    if (!recent.length || base.length < 7) continue;
    const per = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
    const posOf = (a) => { const i = a.reduce((s, x) => s + x.impressions, 0); return i ? a.reduce((s, x) => s + x.position * x.impressions, 0) / i : null; };
    const cR = per(recent, 'clicks'), cB = per(base, 'clicks');
    if (cB >= 5 && cR < cB * 0.6) {
      await raise({ date: d, severity: 'urgent', kind: 'page_drop', page_url: p, title: `Clicks on ${p} down ${Math.round((1 - cR / cB) * 100)}%`, detail: `${cR.toFixed(1)} clicks a day over the last 3 days vs ${cB.toFixed(1)} before.`, dedupe_key: `page_drop|${p}|${d}` });
    }
    const pR = posOf(recent), pB = posOf(base), iR = recent.reduce((s, x) => s + x.impressions, 0);
    if (pR && pB && iR >= 50 && pR - pB > 3) {
      await raise({ date: d, severity: 'urgent', kind: 'rank_drop', page_url: p, title: `${p} dropped from position ${pB.toFixed(1)} to ${pR.toFixed(1)}`, detail: 'Average Google position over the last 3 days vs the 2 weeks before.', dedupe_key: `rank_drop|${p}|${d}` });
    }
  }
}

async function siteAlerts() {
  const { data: pages } = await db.from('pages').select('url,status,issues').in('url', KEY_PAGES);
  const today = iso(new Date());
  for (const p of pages || []) {
    if (p.status && p.status !== 200) await raise({ date: today, severity: 'urgent', kind: 'page_status', page_url: p.url, title: `${p.url} returns ${p.status}`, detail: 'One of your main pages isn\'t loading normally for Google.', dedupe_key: `page_status|${p.url}|${today}` });
    if ((p.issues || []).some((i) => i.code === 'noindex')) await raise({ date: today, severity: 'urgent', kind: 'noindex', page_url: p.url, title: `${p.url} is hidden from Google (noindex)`, detail: 'Remove the noindex setting unless this is deliberate.', dedupe_key: `noindex|${p.url}|${today}` });
  }
  const { count } = await db.from('pages').select('url', { count: 'exact', head: true }).gte('status', 400);
  if (count && count >= 5) await raise({ date: today, severity: 'important', kind: 'broken', title: `${count} pages in your sitemap are broken or missing`, detail: 'See the Technical tab.', dedupe_key: `broken|${today}` });
}

async function jobFailure(job, message) {
  const today = iso(new Date());
  await raise({ date: today, severity: 'urgent', kind: 'job_failed', title: `${job} failed`, detail: message, dedupe_key: `job_failed|${job}|${today}` });
}

module.exports = { trafficAlerts, siteAlerts, jobFailure, KEY_PAGES };
