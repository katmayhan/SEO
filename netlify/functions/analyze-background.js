// Weekly analysis: turns Search Console + site scan + AI checks into suggestions per tab,
// blog ideas with a full strategy, alt-text proposals, and measures changes made 28+ days ago.
const { db, json, isJobCall, startRun, endRun, claude, claudeText, parseJSON, MODEL_MAIN, MODEL_FAST, BRAND_BRIEF } = require('../../lib/shared');

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
  const r = await claude({
    model: MODEL_FAST, max_tokens: 3000,
    messages: [{ role: 'user', content: `Write alt text (max 110 characters, British English, describe what is in the image, mention the product name, add "to hire" only where natural, no "image of") for each image on baboodle.co.uk. Reply as JSON {"alts":[{"i":0,"alt":"..."}]}.\n${list}` }],
  });
  const alts = parseJSON(claudeText(r)).alts || [];
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
  const run = await startRun('analyze');
  try {
    const measured = await measure();

    const { data: lastDay } = await db.from('gsc_site_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (!lastDay) throw new Error('No Search Console data yet');
    const dTo = lastDay.date, dFrom = iso(new Date(new Date(dTo) - 27 * 864e5));
    const { data: kw, error: kwErr } = await db.rpc('kw_window', { d_from: dFrom, d_to: dTo, lim: 1500 });
    if (kwErr) throw new Error(kwErr.message);
    const queries = (kw || []).map((r) => ({ query: r.query, page: r.page, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.ctr), position: Number(r.pos) }));
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

    const dataPack = JSON.stringify({ top_queries_28d: topQueries, top_pages_28d: topPages, site_scan: scanBrief, ai_answer_checks: aeo, recent_changes: changes, open_suggestions: openS, existing_blog_ideas: oldBlogs });

    const errors = [];
    let sugs = [], blogs = [], alts = 0;
    // 1) Suggestions for each tab
    try {
    const sResp = await claude({
      model: MODEL_MAIN, max_tokens: 16000,
      system: BRAND_BRIEF + '\nYou are Baboodle\'s SEO and AEO strategist. Be specific: name the page, the search, the number. Prioritise by likely extra bookings. Do not repeat open suggestions or suggest undoing recent changes. Note: Search Console has no search-volume data, impressions are your demand signal.',
      messages: [{ role: 'user', content: `Here is this week's data (Search Console last 28 days, site scan, AI answer checks):\n${dataPack}\n\nWrite 10–15 new suggestions (keep each detail under 60 words and copy under 120 words) across these categories: "keywords" (searches to target or strengthen, with the page that should own them), "onpage" (content to add or change on a page, with a short draft of the copy in proposed.copy), "meta" (title/description rewrites where impressions are high but CTR is low for the position: proposed.title ≤60 chars and proposed.description ≤155 chars, plus proposed.current_title), "technical" (from the scan issues, grouped, highest impact first), "aeo" (what to add or change so AI answers cite Baboodle for questions marked missing/mentioned).\nReply as JSON: {"suggestions":[{"category":"...","title":"short headline with the key number","detail":"2-3 sentences: what, why, expected effect","page_url":"/path or null","priority":"high|medium|low","effort_minutes":15,"proposed":{}}]}  (effort_minutes = realistic time for Katie to do it herself in Shopify, 5–90)` }],
    });
    sugs = (parseJSON(claudeText(sResp)).suggestions || []).filter((s) => s.title && s.category);
    if (sugs.length) await db.from('suggestions').insert(sugs.map((s) => ({ category: s.category, title: s.title, detail: s.detail, page_url: s.page_url || null, priority: s.priority || 'medium', effort_minutes: s.effort_minutes || null, proposed: s.proposed || {} })));

    } catch (e) { errors.push('suggestions: ' + e.message); }

    // 2) Blog ideas with strategy (live web search to see who ranks now)
    try {
    const bResp = await claude({
      model: MODEL_MAIN, max_tokens: 16000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'GB' } }],
      system: BRAND_BRIEF + '\nYou plan Baboodle\'s blog. Each post must win real searches parents make and lead readers to a hire page.',
      messages: [{ role: 'user', content: `Search Console queries (last 28 days, with Baboodle's current position and page):\n${JSON.stringify(topQueries)}\nAI answer checks:\n${JSON.stringify(aeo)}\nExisting ideas (do not repeat): ${JSON.stringify(oldBlogs)}\n\nPropose the 4 best NEW blog posts. Prefer clusters with lots of impressions where Baboodle ranks below 8 or has no page that answers the search. Use web search to see what currently ranks in Google UK for the main search of each.\nReply as JSON: {"blogs":[{"title":"","target_page":"/collections/...","intent":"who is searching and why, 1-2 sentences","cluster":["exact queries from the list above that this post targets"],"extra_searches":["closely related searches people make, even if not in the list"],"questions":["People also ask style questions to answer"],"outline":["H2 sections in order"],"products":["products to feature"],"angle":"what makes it better than what ranks now","ranking":{"main_search":"","target_position":5,"timeframe":"3 months","difficulty":"low|medium|high","currently_ranking":[{"name":"","url":"","note":""}],"bonus":"snippet / People also ask / AI answers"},"conversion_path":"how readers get to a hire page and book"}]}` }],
    });
    blogs = parseJSON(claudeText(bResp)).blogs || [];
    for (const b of blogs) {
      const cluster = (b.cluster || []).map((q) => {
        const g = queries.find((x) => x.query.toLowerCase() === String(q).toLowerCase());
        return { query: q, impressions_28d: g ? g.impressions : 0, position: g ? g.position : null, clicks_28d: g ? g.clicks : 0 };
      });
      const demand = Math.round(cluster.reduce((x, c) => x + c.impressions_28d, 0) * 30 / 28);
      const target = (b.ranking && b.ranking.target_position) || 5;
      const clicks = Math.round(demand * ctrAt(target));
      const toHire = Math.round(clicks * 0.25);
      const bookings = +(toHire * BOOKING_RATE).toFixed(1);
      await db.from('blog_ideas').insert({
        title: b.title, target_page: b.target_page, intent: b.intent, cluster: { queries: cluster, extra_searches: b.extra_searches || [], questions: b.questions || [] },
        total_demand: demand, outline: { sections: b.outline || [], products: b.products || [], angle: b.angle || '' }, ranking: b.ranking || {},
        conversion: { monthly_demand: demand, target_position: target, ctr: ctrAt(target), clicks, to_hire_page: toHire, booking_rate: BOOKING_RATE, bookings, path: b.conversion_path || '' },
        expected_bookings: bookings, status: 'idea',
      });
    }

    } catch (e) { errors.push('blogs: ' + e.message); }

    try { alts = await altText(); } catch (e) { errors.push('alt text: ' + e.message); }
    try {

    // 3) This week's plan: fits in Katie's 3 hours
    const { data: openNow } = await db.from('suggestions').select('id,category,title,detail,page_url,priority,effort_minutes').in('status', ['suggested', 'approved']).neq('category', 'images').order('created_at', { ascending: false }).limit(80);
    const { count: altCount } = await db.from('suggestions').select('id', { count: 'exact', head: true }).eq('category', 'images').eq('status', 'suggested');
    const { data: ideas } = await db.from('blog_ideas').select('id,title,status,expected_bookings,target_page').in('status', ['idea', 'draft_ready']).order('expected_bookings', { ascending: false }).limit(8);
    const { data: openAlerts } = await db.from('alerts').select('id,title,detail,severity').eq('resolved', false).order('created_at', { ascending: false }).limit(10);
    const pResp = await claude({
      model: MODEL_MAIN, max_tokens: 3000,
      system: BRAND_BRIEF + '\nYou plan Katie\'s SEO and AEO week. She has exactly 3 hours (180 minutes) a week. Pick the highest-impact work that fits, in the order she should do it. Fix urgent problems first, then quick wins with the most expected extra bookings, then one bigger piece (usually a blog). Batch small similar jobs (e.g. "25 alt texts, 20 min").',
      messages: [{ role: 'user', content: `Open alerts: ${JSON.stringify(openAlerts)}\nOpen suggestions (with effort in minutes): ${JSON.stringify(openNow)}\nAlt texts waiting: ${altCount}\nBlog ideas (a blog takes ~60 min to review and publish once drafted; drafting is automatic): ${JSON.stringify(ideas)}\n\nReply as JSON {"summary":"one or two sentences on the focus this week","items":[{"type":"suggestion|blog|alert|alt_text","ref_id":"id or null","title":"","why":"one sentence with the expected effect","minutes":20,"steps":["short step"]}]} with total minutes ≤ 180.` }],
    });
    const plan = parseJSON(claudeText(pResp));
    const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    await db.from('weekly_plans').upsert({ week_of: monday.toISOString().slice(0, 10), budget_minutes: 180, summary: plan.summary || '', items: plan.items || [], emailed_at: null }, { onConflict: 'week_of' });
    } catch (e) { errors.push('plan: ' + e.message); }
    await endRun(run, errors.length ? 'partial' : 'ok', `${sugs.length} suggestions, ${blogs.length} blog ideas, ${alts} alt texts, ${measured} results measured${errors.length ? ' · problems: ' + errors.join(' | ') : ''}`);
    return json(200, { ok: true });
  } catch (e) {
    await endRun(run, 'error', e.message);
    return json(500, { error: e.message });
  }
};
