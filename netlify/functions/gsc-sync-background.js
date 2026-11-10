// Pulls Search Console data day by day into Supabase.
// First run backfills 90 days; after that it refreshes the last 5 days (GSC data settles over ~3 days).
const { db, json, toPath, isJobCall, startRun, endRun, gscToken, gscQuery } = require('../../lib/shared');

function iso(d) { return d.toISOString().slice(0, 10); }

async function upsertChunks(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + size));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  const run = await startRun('gsc-sync');
  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const token = await gscToken();

    const { count } = await db.from('gsc_site_daily').select('date', { count: 'exact', head: true });
    const days = body.days || (count ? 5 : 90);

    const end = new Date(Date.now() - 2 * 864e5);
    let done = 0;
    for (let i = days - 1; i >= 0; i--) {
      const date = iso(new Date(end.getTime() - i * 864e5));

      const site = await gscQuery(token, { startDate: date, endDate: date, dataState: 'all' });
      if (!site.length) continue;
      const s = site[0];
      await db.from('gsc_site_daily').upsert({ date, clicks: s.clicks, impressions: s.impressions, ctr: s.ctr, position: s.position });

      const pages = await gscQuery(token, { startDate: date, endDate: date, dimensions: ['page'], rowLimit: 5000, dataState: 'all' });
      const pageRows = {};
      for (const r of pages) {
        const page = toPath(r.keys[0]);
        if (pageRows[page]) continue; // keep the first (largest) if two URLs collapse to one path
        pageRows[page] = { date, page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
      }
      await upsertChunks('gsc_page_daily', Object.values(pageRows));

      const queries = await gscQuery(token, { startDate: date, endDate: date, dimensions: ['page', 'query'], rowLimit: 5000, dataState: 'all' });
      const qRows = {};
      for (const r of queries) {
        const page = toPath(r.keys[0]);
        const key = page + '|' + r.keys[1];
        if (qRows[key]) continue;
        qRows[key] = { date, page, query: r.keys[1], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
      }
      await upsertChunks('gsc_query_daily', Object.values(qRows));
      done++;
    }
    // keep the query table lean: drop query detail older than 400 days
    await db.from('gsc_query_daily').delete().lt('date', iso(new Date(Date.now() - 400 * 864e5)));
    await endRun(run, 'ok', `Synced ${done} day(s)`);
    return json(200, { ok: true, days: done });
  } catch (e) {
    await endRun(run, 'error', e.message);
    return json(500, { error: e.message });
  }
};
