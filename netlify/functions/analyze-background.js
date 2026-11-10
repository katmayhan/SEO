// Weekly analysis: turns Search Console + site scan + AI checks into suggestions per tab,
// blog ideas with a full strategy, alt-text proposals, and measures changes made 28+ days ago.
const vol = require('../../lib/volumes');
const { db, json, isJobCall, startRun, endRun, claude, claudeJSON, claudeText, parseJSON, MODEL_MAIN, MODEL_FAST, BRAND_BRIEF: BASE_BRIEF, strategyBrief } = require('../../lib/shared');
let BRAND_BRIEF = BASE_BRIEF;

const SUG_SCHEMA = { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'object', properties: { category: { type: 'string', enum: ['keywords', 'onpage', 'meta', 'technical', 'aeo'] }, title: { type: 'string' }, detail: { type: 'string' }, page_url: { type: ['string', 'null'] }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, effort_minutes: { type: 'integer' }, strategy_score: { type: 'integer' }, strategy_note: { type: 'string' }, proposed: { type: 'object' } }, required: ['category', 'title', 'detail', 'priority', 'effort_minutes', 'strategy_score'] } } }, required: ['suggestions'] };
const ALT_SCHEMA = { type: 'object', properties: { alts: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, alt: { type: 'string' } }, required: ['i', 'alt'] } } }, required: ['alts'] };
const PLAN_SCHEMA = { type: 'object', properties: { summary: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['suggestion', 'blog', 'alert', 'alt_text', 'strategy'] }, ref_id: { type: ['string', 'null'] }, title: { type: 'string' }, why: { type: 'string' }, strategy_fit: { type: 'string' }, minutes: { type: 'integer' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['type', 'title', 'why', 'strategy_fit', 'minutes'] } } }, required: ['summary', 'items'] };
const SCORE_SCHEMA = { type: 'object', properties: { scores: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, score: { type: 'integer' }, note: { type: 'string' } }, required: ['i', 'score', 'note'] } } }, required: ['scores'] };
const SCORE_GUIDE = 'Strategy score 0–5: 5 = directly serves a top priority in the strategy (and recurring, long-term customers); 4 = serves a listed priority; 3 = supports the hub, site health or authority in a way that helps the priorities; 2 = generic, neutral; 1 = mostly one-off or low-value traffic; 0 = goes against the strategy (a product or topic it says not to push, or breaks one of its rules).';

// Score blog ideas and open suggestions against the current strategy (cheap; re-run whenever the strategy changes)
async function scoreAgainstStrategy() {
  const { data: ideas } = await db.from('blog_ideas').select('id,title,target_page,intent').in('status', ['idea', 'draft_ready']).is('strategy_score', null).limit(60);
  const { data: sug } = await db.from('suggestions').select('id,title,detail,page_url').in('status', ['suggested', 'approved']).neq('category', 'images').is('strategy_score', null).limit(80);
  const list = [...(ideas || []).map((x) => ({ t: 'blog_ideas', id: x.id, text: `Blog: ${x.title} (feeds ${x.target_page}) ${x.intent || ''}` })), ...(sug || []).map((x) => ({ t: 'suggestions', id: x.id, text: `Task: ${x.title} – ${x.detail || ''} (${x.page_url || ''})` }))];
  if (!list.length) return 0;
  const out = await claudeJSON({
    model: MODEL_FAST, max_tokens: 4000, schema: SCORE_SCHEMA,
    system: BRAND_BRIEF + '\n' + SCORE_GUIDE,
    messages: [{ role: 'user', content: `Score each item against Baboodle's strategy. Note = under 15 words naming the priority it serves, or why it conflicts.\n${list.map((x, i) => `${i}. ${x.text.slice(0, 300)}`).join('\n')}` }],
  });
  for (const s of out.scores || []) {
    const x = list[s.i]; if (!x) continue;
    await db.from(x.t).update({ strategy_score: Math.max(0, Math.min(5, s.score)), strategy_note: s.note }).eq('id', x.id);
  }
  return (out.scores || []).length;
}

// This week's plan: fits in Katie's 3 hours, led by the strategy
async function buildPlan() {
  await scoreAgainstStrategy();
  const { data: openNow } = await db.from('suggestions').select('id,category,title,detail,page_url,priority,effort_minutes,strategy_score,strategy_note').in('status', ['suggested', 'approved']).neq('category', 'images').order('created_at', { ascending: false }).limit(80);
  const { count: altCount } = await db.from('suggestions').select('id', { count: 'exact', head: true }).eq('category', 'images').eq('status', 'suggested');
  const { data: ideas } = await db.from('blog_ideas').select('id,title,status,expected_bookings,target_page,strategy_score,strategy_note').in('status', ['idea', 'draft_ready']).limit(30);
  const { data: openAlerts } = await db.from('alerts').select('id,title,detail,severity').eq('resolved', false).order('created_at', { ascending: false }).limit(10);
  const blocked = new Set([...(openNow || []), ...(ideas || [])].filter((x) => x.strategy_score === 0).map((x) => x.id));
  const okSugs = (openNow || []).filter((x) => !blocked.has(x.id));
  const okIdeas = (ideas || []).filter((x) => !blocked.has(x.id)).sort((a, b) => (b.strategy_score || 0) - (a.strategy_score || 0) || (b.expected_bookings || 0) - (a.expected_bookings || 0));
  // pages already earning traffic: protect and grow the ones the strategy cares about
  let topPages = [];
  try {
    const { data: lastDay } = await db.from('gsc_site_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (lastDay) {
      const to = lastDay.date, from = new Date(new Date(to) - 27 * 864e5).toISOString().slice(0, 10);
      const { data: pw } = await db.rpc('page_window', { d_from: from, d_to: to });
      topPages = (pw || []).map((r) => ({ page: r.page, clicks_28d: Number(r.clicks), shown_28d: Number(r.impressions), position: Number(r.pos) })).sort((a, b) => b.clicks_28d - a.clicks_28d).slice(0, 15);
    }
  } catch (e) {}
  const plan = await claudeJSON({
    model: MODEL_MAIN, max_tokens: 4000, schema: PLAN_SCHEMA,
    system: BRAND_BRIEF + `\nYou plan Katie's SEO and AEO week. She has exactly 3 hours (180 minutes). The plan must move Baboodle's long-term strategy above, not just chase this month's traffic.
Rules, in order:
1. Only urgent alerts (site broken, key page lost, big drop) come first. Otherwise skip alerts.
2. Spend at least two thirds of the time (120+ minutes) on work with strategy score 4–5. Strategy score beats expected bookings: "expected bookings" is worked out from searches where Baboodle already shows up, so it badly undercounts new priority areas (e.g. newborn, doubles, running) where Baboodle isn't visible yet. Recurring rental customers are worth far more than one-off hires.
3. Never include anything the strategy says not to push, even if its numbers are big.
4. If the options below don't cover a top priority well, add your own item (type "strategy", ref_id null) taken from the strategy's "content we want" or priority list, e.g. starting a data-led guide or improving a priority collection page, with concrete steps.
5. Look at the top pages by clicks. Any page the strategy names or that serves a priority (e.g. a location or category page) and already sits at position 4–10 with lots of impressions is the fastest win available: moving it into the top 3 roughly doubles its clicks. Include at least one item that protects or grows such a page if there is one, even if no open suggestion covers it (add your own "strategy" item with concrete steps). Never spend time on pages for products the strategy says not to push, however much traffic they get.
6. Every focus area the strategy names should be covered over the course of a month; if one has had nothing recently, give it time this week.
7. Fill leftover time with quick wins (alt text batches, meta fixes) on priority pages first. Batch small similar jobs.
8. Spread across at least two priorities where sensible, and keep one bigger piece at most (a blog takes ~60 min to review and publish once drafted; drafting is automatic).
For every item, strategy_fit names the priority it serves in a few words (e.g. "Priority 1: double prams").`,
    messages: [{ role: 'user', content: `Open alerts: ${JSON.stringify(openAlerts)}\nOpen suggestions (effort in minutes, strategy_score 0–5): ${JSON.stringify(okSugs)}\nAlt texts waiting: ${altCount}\nTop pages by clicks (last 28 days): ${JSON.stringify(topPages)}\nBlog ideas (sorted by strategy score): ${JSON.stringify(okIdeas)}\n\nReply as JSON {"summary":"one or two sentences on this week's focus and which strategy priorities it moves","items":[{"type":"suggestion|blog|alert|alt_text|strategy","ref_id":"id or null","title":"","why":"one sentence with the expected effect","strategy_fit":"","minutes":20,"steps":["short step"]}]} with total minutes ≤ 180.` }],
  });
  const items = (plan.items || []).filter((i) => !(i.ref_id && blocked.has(i.ref_id)));
  const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  await db.from('weekly_plans').upsert({ week_of: monday.toISOString().slice(0, 10), budget_minutes: 180, summary: plan.summary || '', items, emailed_at: null }, { onConflict: 'week_of' });
  return items.length;
}

const BOOKING_RATE = Number(process.env.BOOKING_RATE || 0.026); // search visitors who book (Shopify, pram hire, Oct–Nov 2026)
const CTR_AT = [0, 0.28, 0.16, 0.11, 0.08, 0.065, 0.05, 0.04, 0.032, 0.027, 0.023];
const ctrAt = (p) => CTR_AT[Math.max(1, Math.min(10, Math.round(p)))] || 0.01;
const iso = (d) => d.toISOString().slice(0, 10);

async function all(q) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(error.message);
    out = out.concat(data || []);
    if (!data || data.length < 1000) return out;
    from += 1000;
  }
}

async function measure() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: due } = await db.from('suggestions').select('*').eq('status', 'done').is('measured_at', null).lte('actioned_at', cutoff);
  for (const s of due || []) {
    if (!s.page_url) { await db.from('suggestions').update({ measured_at: new Date().toISOString(), result: { verdict: 'not_measurable' } }).eq('id', s.id); continue; }
    const t = new Date(s.actioned_at);
    const before = await all(db.from('gsc_page_daily').select('clicks,impressions,position').eq('page', s.page_url).gte('date', iso(new Date(t - 28 * 864e5))).lt('date', iso(t)));
    const after = await all(db.from('gsc_page_daily').select('clicks,impressions,position').eq('page', s.page_url).gt('date', iso(t)).lte('date', iso(new Date(+t + 28 * 864e5))));
    const sum = (a, k) => a.reduce((x, r) => x + r[k], 0);
    const pos = (a) => { const i = sum(a, 'impressions'); return i ? +(a.reduce((x, r) => x + r.position * r.impressions, 0) / i).toFixed(1) : null; };
    const r = { clicks_before: sum(before, 'clicks'), clicks_after: sum(after, 'clicks'), impressions_before: sum(before, 'impressions'), impressions_after: sum(after, 'impressions'), position_before: pos(before), position_after: pos(after) };
    const change = r.clicks_before ? (r.clicks_after - r.clicks_before) / r.clicks_before : r.clicks_after > 0 ? 1 : 0;
    r.verdict = change > 0.1 ? 'win' : change < -0.1 ? 'loss' : 'flat';
    await db.from('suggestions').update({ result: r, measured_at: new Date().toISOString() }).eq('id', s.id);
  }
  return (due || []).length;
}

async function altText() {
  const imgs = await all(db.from('images').select('page_url,src,alt').eq('alt', ''));
  const { data: existing } = await db.from('suggestions').select('proposed').eq('category', 'images').neq('status', 'dismissed');
  const seen = new Set((existing || []).map((s) => s.proposed && s.proposed.src));
  const todo = imgs.filter((i) => !seen.has(i.src)).slice(0, 40);
  if (!todo.length) return 0;
  const { data: pages } = await db.from('pages').select('url,title,h1').in('url', [...new Set(todo.map((t) => t.page_url))]);
  const pmap = Object.fromEntries((pages || []).map((p) => [p.url, p]));
  const list = todo.map((t, i) => `${i}. page "${(pmap[t.page_url] || {}).h1 || (pmap[t.page_url] || {}).title || t.page_url}" · file ${t.src.split('/').pop()}`).join('\n');
  const altOut = await claudeJSON({
    model: MODEL_FAST, max_tokens: 4000, schema: ALT_SCHEMA,
    messages: [{ role: 'user', content: `Write alt text (max 110 characters, British English, describe what is in the image, mention the product name, add "to hire" only where natural, no "image of") for each image on baboodle.co.uk, keyed by its number i.\n${list}` }],
  });
  const alts = altOut.alts || [];
  const rows = alts.filter((a) => todo[a.i]).map((a) => ({
    category: 'images', priority: 'low', page_url: todo[a.i].page_url,
    title: `Alt text for ${todo[a.i].src.split('/').pop().slice(0, 60)}`,
    detail: `Image on ${todo[a.i].page_url} has no alt text.`,
    proposed: { src: todo[a.i].src, alt: a.alt },
  }));
  if (rows.length) await db.from('suggestions').insert(rows);
  return rows.length;
}

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  // don't run two analyses at once (avoids duplicate suggestions)
  const { data: busy } = await db.from('runs').select('id').eq('job', 'analyze').eq('status', 'running').gte('started_at', new Date(Date.now() - 20 * 60000).toISOString()).limit(1);
  if (busy && busy.length) return json(200, { skipped: 'already running' });
  const body = (() => { try { return JSON.parse(event.body || '{}'); } catch { return {}; } })();
  const run = await startRun('analyze');
  BRAND_BRIEF = await strategyBrief();
  if (body.only === 'plan') {
    try { const n = await buildPlan(); await endRun(run, 'ok', `Plan rebuilt around the strategy (${n} items)`); return json(200, { ok: true }); }
    catch (e) { await endRun(run, 'error', 'plan: ' + e.message); return json(500, { error: e.message }); }
  }
  try {
    const measured = await measure();

    const { data: lastDay } = await db.from('gsc_site_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (!lastDay) throw new Error('No Search Console data yet');
    const dTo = lastDay.date, dFrom = iso(new Date(new Date(dTo) - 27 * 864e5));
    const { data: kw, error: kwErr } = await db.rpc('kw_window', { d_from: dFrom, d_to: dTo, lim: 1500 });
    if (kwErr) throw new Error(kwErr.message);
    const queries = (kw || []).map((r) => ({ query: r.query, page: r.page, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.ctr), position: Number(r.pos) }));
    // Keyword Planner volumes (DataForSEO): refresh, then attach real monthly searches
    let volNote = '', gapList = [], volErr = null;
    try {
      const vr = await vol.refresh(queries.map((x) => x.query), BRAND_BRIEF);
      if (!vr.skipped) {
        const vm = await vol.lookup(queries.slice(0, 400).map((x) => x.query));
        queries.forEach((x) => { const v = vm[vol.clean(x.query)]; if (v) x.monthly_searches = v.search_volume; });
        gapList = (await vol.gaps(queries, 80)).map((g) => ({ search: g.keyword, monthly_searches: g.search_volume, your_position: g.position, cpc: g.cpc }));
        volNote = ' monthly_searches = real UK Google monthly searches from Keyword Planner. Use it as the main demand signal; impressions only count searches where Baboodle already shows.';
      }
    } catch (e) { volErr = 'keyword volumes: ' + e.message; }
    const topQueries = queries.slice(0, 180);
    const { data: pw } = await db.rpc('page_window', { d_from: dFrom, d_to: dTo });
    const topPages = (pw || []).map((r) => ({ page: r.page, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.ctr), position: Number(r.pos) })).sort((a, b) => b.impressions - a.impressions).slice(0, 50);

    const scanned = await all(db.from('pages').select('url,page_type,status,title,meta_description,h1,word_count,has_faq_schema,internal_links_in,img_missing_alt,issues'));
    const trafficSet = new Set(topPages.map((p) => p.page));
    const scanBrief = scanned
      .filter((p) => trafficSet.has(p.url) || p.page_type === 'collection' || (p.issues || []).some((i) => i.sev === 'high'))
      .slice(0, 90)
      .map((p) => ({ url: p.url, type: p.page_type, status: p.status, title: p.title, meta: p.meta_description, h1: p.h1, words: p.word_count, faq: p.has_faq_schema, links_in: p.internal_links_in, issues: (p.issues || []).map((i) => i.text) }));

    const { data: aeoQ } = await db.from('aeo_questions').select('id,question').eq('active', true);
    const { data: aeoC } = await db.from('aeo_checks').select('question_id,status,competitors,checked_at').order('checked_at', { ascending: false }).limit(200);
    const latest = {};
    (aeoC || []).forEach((c) => { if (!latest[c.question_id]) latest[c.question_id] = c; });
    const aeo = (aeoQ || []).map((q) => ({ question: q.question, status: (latest[q.id] || {}).status || 'not checked', named_instead: (latest[q.id] || {}).competitors || [] }));

    const { data: openS } = await db.from('suggestions').select('title,category,status').in('status', ['suggested', 'approved']).neq('category', 'images');
    const { data: oldBlogs } = await db.from('blog_ideas').select('title,status');
    const { data: changes } = await db.from('changes').select('date,page_url,description').order('date', { ascending: false }).limit(20);

    const dataPack = JSON.stringify({ top_queries_28d: topQueries, demand_where_baboodle_is_not_on_page_1: gapList, top_pages_28d: topPages, site_scan: scanBrief, ai_answer_checks: aeo, recent_changes: changes, open_suggestions: openS, existing_blog_ideas: oldBlogs });

    const errors = volErr ? [volErr] : [];
    let sugs = [], blogs = [], alts = 0;
    // 1) Suggestions for each tab
    try {
    const sOut = await claudeJSON({
      model: MODEL_MAIN, max_tokens: 16000, schema: SUG_SCHEMA,
      system: BRAND_BRIEF + '\nYou are Baboodle\'s SEO and AEO strategist. Be specific: name the page, the search, the number. Prioritise by how much it moves Baboodle\'s strategy (long-term customers and the priority categories) and likely extra bookings. Do not repeat open suggestions or suggest undoing recent changes. Cover every focus area the strategy names (categories, products and locations such as London), and look hard at strategy pages that already earn clicks but sit at position 4–10: lifting those into the top 3 is usually the quickest win. Never work on pages for products the strategy says not to push, however much traffic they get. ' + (volNote ? 'Note:' + volNote + ' Use demand_where_baboodle_is_not_on_page_1 to spot on-strategy searches with real demand that Baboodle is missing, and say which page should win each.' : 'Note: Search Console has no search-volume data, impressions are your demand signal.'),
      messages: [{ role: 'user', content: `Here is this week's data (Search Console last 28 days, site scan, AI answer checks):\n${dataPack}\n\nWrite 10–15 new suggestions (keep each detail under 60 words and copy under 120 words) across these categories: "keywords" (searches to target or strengthen, with the page that should own them), "onpage" (content to add or change on a page, with a short draft of the copy in proposed.copy), "meta" (title/description rewrites where impressions are high but CTR is low for the position: proposed.title ≤60 chars and proposed.description ≤155 chars, plus proposed.current_title), "technical" (from the scan issues, grouped, highest impact first), "aeo" (what to add or change so AI answers cite Baboodle for questions marked missing/mentioned).\nReply as JSON: {"suggestions":[{"category":"...","title":"short headline with the key number","detail":"2-3 sentences: what, why, expected effect, and which part of the strategy it serves","page_url":"/path or null","priority":"high|medium|low","effort_minutes":15,"strategy_score":4,"strategy_note":"priority it serves","proposed":{}}]}  (effort_minutes = realistic time for Katie to do it herself in Shopify, 5–90). ${SCORE_GUIDE} At least two thirds of suggestions should score 4–5. Do not suggest anything that would score 0.` }],
    });
    sugs = (sOut.suggestions || []).filter((s) => s.title && s.category);
    if (sugs.length) await db.from('suggestions').insert(sugs.map((s) => ({ category: s.category, title: s.title, detail: s.detail, page_url: s.page_url || null, priority: s.priority || 'medium', effort_minutes: s.effort_minutes || null, strategy_score: s.strategy_score != null ? Math.max(0, Math.min(5, s.strategy_score)) : null, strategy_note: s.strategy_note || null, proposed: s.proposed || {} })));

    } catch (e) { errors.push('suggestions: ' + e.message); }

    // 2) Blog ideas with strategy (live web search to see who ranks now)
    try {
    const bResp = await claude({
      model: MODEL_MAIN, max_tokens: 16000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'GB' } }],
      system: BRAND_BRIEF + '\nYou plan Baboodle\'s blog. Each post must win real searches parents make and lead readers to a hire page.',
      messages: [{ role: 'user', content: `Search Console queries (last 28 days, with Baboodle's current position and page):\n${JSON.stringify(topQueries)}${gapList.length ? `\nSearches with real UK demand (Keyword Planner monthly searches) where Baboodle is not on page 1 or doesn't show at all:\n${JSON.stringify(gapList)}\n${volNote}` : ''}\nAI answer checks:\n${JSON.stringify(aeo)}\nExisting ideas (do not repeat): ${JSON.stringify(oldBlogs)}\n\nPropose the 4 best NEW blog posts for Baboodle's strategy. Start from the strategy's priorities and "content we want", then use the search data to pick the angle and the searches to target. Among on-strategy ideas, prefer clusters with the most real demand (monthly searches where known, otherwise impressions) where Baboodle ranks below 8 or has no page that answers the search. Never propose posts about products or topics the strategy says not to push. ${SCORE_GUIDE} Only propose posts scoring 4–5 (at most one scoring 3). Use web search to see what currently ranks in Google UK for the main search of each.\nReply as JSON: {"blogs":[{"title":"","target_page":"/collections/...","intent":"who is searching and why, 1-2 sentences","cluster":["exact searches from either list above that this post targets"],"extra_searches":["closely related searches people make, even if not in the list"],"questions":["People also ask style questions to answer"],"outline":["H2 sections in order"],"products":["products to feature"],"angle":"what makes it better than what ranks now","ranking":{"main_search":"","target_position":5,"timeframe":"3 months","difficulty":"low|medium|high","currently_ranking":[{"name":"","url":"","note":""}],"bonus":"snippet / People also ask / AI answers"},"conversion_path":"how readers get to a hire page and book","strategy_score":5,"strategy_note":"priority it serves"}]}` }],
    });
    blogs = parseJSON(claudeText(bResp)).blogs || [];
    for (const b of blogs) {
      const vmap = await vol.lookup((b.cluster || []).map(String)).catch(() => ({}));
      const cluster = (b.cluster || []).map((q) => {
        const g = queries.find((x) => x.query.toLowerCase() === String(q).toLowerCase());
        const v = vmap[vol.clean(q)];
        return { query: q, impressions_28d: g ? g.impressions : 0, position: g ? g.position : null, clicks_28d: g ? g.clicks : 0, monthly_searches: v ? v.search_volume : null };
      });
      // real monthly searches where Keyword Planner knows them, otherwise Search Console impressions scaled to a month
      const demand = Math.round(cluster.reduce((x, c) => x + (c.monthly_searches != null ? c.monthly_searches : c.impressions_28d * 30 / 28), 0));
      const target = (b.ranking && b.ranking.target_position) || 5;
      const clicks = Math.round(demand * ctrAt(target));
      const toHire = Math.round(clicks * 0.25);
      const bookings = +(toHire * BOOKING_RATE).toFixed(1);
      await db.from('blog_ideas').insert({
        title: b.title, target_page: b.target_page, intent: b.intent, cluster: { queries: cluster, extra_searches: b.extra_searches || [], questions: b.questions || [] },
        total_demand: demand, outline: { sections: b.outline || [], products: b.products || [], angle: b.angle || '' }, ranking: b.ranking || {},
        conversion: { monthly_demand: demand, target_position: target, ctr: ctrAt(target), clicks, to_hire_page: toHire, booking_rate: BOOKING_RATE, bookings, path: b.conversion_path || '' },
        expected_bookings: bookings, status: 'idea', strategy_score: b.strategy_score != null ? Math.max(0, Math.min(5, b.strategy_score)) : null, strategy_note: b.strategy_note || null,
      });
    }

    } catch (e) { errors.push('blogs: ' + e.message); }

    try { alts = await altText(); } catch (e) { errors.push('alt text: ' + e.message); }
    try { await buildPlan(); } catch (e) { errors.push('plan: ' + e.message); }
    await endRun(run, errors.length ? 'partial' : 'ok', `${sugs.length} suggestions, ${blogs.length} blog ideas, ${alts} alt texts, ${measured} results measured${errors.length ? ' · problems: ' + errors.join(' | ') : ''}`);
    return json(200, { ok: true });
  } catch (e) {
    await endRun(run, 'error', e.message);
    return json(500, { error: e.message });
  }
};
