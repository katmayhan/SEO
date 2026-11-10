// Keyword Planner data (Google Ads search volumes) via DataForSEO.
// Needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in Netlify. Without them everything here quietly does nothing.
const { db, claudeJSON, MODEL_FAST } = require('./shared');

const UK = { location_code: 2826, language_code: 'en' };
const MAX_AGE_DAYS = 30;

const configured = () => !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

async function dfs(path, tasks) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  const res = await fetch(`https://api.dataforseo.com/v3/${path}`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tasks),
  });
  const d = await res.json().catch(() => ({}));
  if (d.status_code !== 20000) throw new Error('DataForSEO: ' + (d.status_message || res.status));
  const out = [];
  for (const t of d.tasks || []) {
    if (t.status_code !== 20000) throw new Error('DataForSEO: ' + t.status_message);
    (t.result || []).forEach((r) => out.push(r));
  }
  return out;
}

// Google Ads only accepts plain keywords: ≤80 chars, ≤10 words, no odd symbols
const clean = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9£&' -]/g, ' ').replace(/\s+/g, ' ').trim();
const okKw = (k) => k && k.length <= 80 && k.split(' ').length <= 10;

const row = (r, source, seed) => ({
  keyword: clean(r.keyword), search_volume: r.search_volume ?? null, cpc: r.cpc ?? null, competition: r.competition ?? null,
  monthly: (r.monthly_searches || []).slice(0, 12).map((m) => ({ y: m.year, m: m.month, v: m.search_volume })), source, seed: seed || null, updated_at: new Date().toISOString(),
});

async function save(rows) {
  const seen = new Map();
  rows.filter((r) => okKw(r.keyword)).forEach((r) => seen.set(r.keyword, r));
  const list = [...seen.values()];
  for (let i = 0; i < list.length; i += 500) await db.from('keyword_volumes').upsert(list.slice(i, i + 500), { onConflict: 'keyword' });
  return list.length;
}

// 1) Search volumes for the searches Baboodle already shows for (refreshed monthly)
async function volumesFor(keywords) {
  const want = [...new Set(keywords.map(clean).filter(okKw))];
  if (!want.length) return 0;
  const { data: have } = await db.from('keyword_volumes').select('keyword,updated_at').in('keyword', want.slice(0, 1000));
  const fresh = new Set((have || []).filter((h) => Date.now() - new Date(h.updated_at) < MAX_AGE_DAYS * 864e5).map((h) => h.keyword));
  const todo = want.filter((k) => !fresh.has(k)).slice(0, 1000);
  if (!todo.length) return 0;
  const res = await dfs('keywords_data/google_ads/search_volume/live', [{ ...UK, keywords: todo }]);
  return save(res.map((r) => row(r, 'gsc')));
}

// 2) Seeds from the strategy: the searches parents make for each priority (cached until the strategy changes)
async function strategySeeds(brief) {
  const { data: st } = await db.from('settings').select('updated_at').eq('key', 'strategy').maybeSingle();
  const stamp = st ? st.updated_at : 'none';
  const { data: cached } = await db.from('settings').select('value').eq('key', 'kw_seeds').maybeSingle();
  if (cached && cached.value) { try { const c = JSON.parse(cached.value); if (c.stamp === stamp && (c.seeds || []).length) return c.seeds; } catch (e) {} }
  const out = await claudeJSON({
    model: MODEL_FAST, max_tokens: 1500,
    schema: { type: 'object', properties: { seeds: { type: 'array', items: { type: 'string' } } }, required: ['seeds'] },
    system: brief,
    messages: [{ role: 'user', content: 'List 20 short Google search phrases (2–4 words, UK English, lowercase) that parents type when looking for what Baboodle\'s strategy priorities offer, spread across the priorities in order of importance. Mix hire/rental searches with research searches (e.g. "best double pram", "running buggy from birth"). Never include anything the strategy says not to push. Reply as {"seeds":[...]}' }],
  });
  const seeds = (out.seeds || []).map(clean).filter(okKw).slice(0, 20);
  await db.from('settings').upsert({ key: 'kw_seeds', value: JSON.stringify({ stamp, seeds }), updated_at: new Date().toISOString() });
  return seeds;
}

// 3) Keyword ideas around those seeds (like Keyword Planner's "discover new keywords"), refreshed monthly
async function ideasFor(seeds) {
  if (!seeds.length) return 0;
  const { data: last } = await db.from('keyword_volumes').select('updated_at').eq('source', 'idea').order('updated_at', { ascending: false }).limit(1).maybeSingle();
  const { data: cached } = await db.from('settings').select('value').eq('key', 'kw_seeds').maybeSingle();
  const seedsChanged = cached && cached.value && last && new Date(JSON.parse(cached.value).stamp || 0) > new Date(last.updated_at);
  if (last && !seedsChanged && Date.now() - new Date(last.updated_at) < MAX_AGE_DAYS * 864e5) return 0;
  const res = await dfs('keywords_data/google_ads/keywords_for_keywords/live', [{ ...UK, keywords: seeds.slice(0, 20), sort_by: 'search_volume' }]);
  return save(res.filter((r) => (r.search_volume || 0) >= 20).map((r) => row(r, 'idea', seeds.find((s) => clean(r.keyword).includes(s.split(' ')[0])) || null)));
}

// Weekly refresh. Costs a few pence a week (1–3 DataForSEO tasks).
async function refresh(gscQueries, brief) {
  if (!configured()) return { skipped: true };
  const a = await volumesFor(gscQueries);
  const seeds = await strategySeeds(brief);
  const b = await ideasFor(seeds);
  return { volumes: a, ideas: b, seeds: seeds.length };
}

async function lookup(keywords) {
  const want = [...new Set(keywords.map(clean))].filter(Boolean);
  const map = {};
  for (let i = 0; i < want.length; i += 500) {
    const { data } = await db.from('keyword_volumes').select('keyword,search_volume,cpc,competition,monthly').in('keyword', want.slice(i, i + 500));
    (data || []).forEach((r) => { map[r.keyword] = r; });
  }
  return map;
}

// Searches with real demand where Baboodle isn't on page 1 (or doesn't show at all)
async function gaps(gscQueries, limit = 80) {
  const { data } = await db.from('keyword_volumes').select('keyword,search_volume,cpc,competition,monthly,seed').order('search_volume', { ascending: false, nullsFirst: false }).limit(600);
  const pos = {};
  gscQueries.forEach((q) => { const k = clean(q.query); if (!pos[k] || q.impressions > pos[k].impressions) pos[k] = q; });
  return (data || [])
    .filter((r) => (r.search_volume || 0) >= 30)
    .map((r) => ({ ...r, position: pos[r.keyword] ? pos[r.keyword].position : null, page: pos[r.keyword] ? pos[r.keyword].page : null }))
    .filter((r) => r.position == null || r.position > 10)
    .slice(0, limit);
}

module.exports = { configured, refresh, lookup, gaps, clean };
