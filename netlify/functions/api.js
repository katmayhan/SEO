// Dashboard data API. Every call needs the dashboard password in the x-dash-key header.
const { db, json, trigger } = require('../../lib/shared');

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(new Date(d).getTime() + n * 864e5));

function totals(rows) {
  const c = rows.reduce((a, r) => a + r.clicks, 0), i = rows.reduce((a, r) => a + r.impressions, 0);
  const pw = rows.reduce((a, r) => a + Number(r.position) * r.impressions, 0);
  return { clicks: c, impressions: i, ctr: i ? c / i : 0, position: i ? pw / i : null, days: rows.length };
}

async function latestDate() {
  const { data } = await db.from('gsc_site_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
  return data ? data.date : null;
}

async function pageRange(page, from, to) {
  const { data } = await db.from('gsc_page_daily').select('date,clicks,impressions,position').eq('page', page).gte('date', from).lte('date', to);
  return totals(data || []);
}

async function overview() {
  const last = await latestDate();
  const { data: tok } = await db.from('gsc_tokens').select('updated_at').limit(1).maybeSingle();
  const { data: runs } = await db.from('runs').select('job,status,message,finished_at,started_at').order('started_at', { ascending: false }).limit(30);
  const lastRuns = {};
  (runs || []).forEach((r) => { if (!lastRuns[r.job]) lastRuns[r.job] = r; });

  const { data: sug } = await db.from('suggestions').select('category,priority').eq('status', 'suggested');
  const todo = {};
  (sug || []).forEach((s) => { todo[s.category] = (todo[s.category] || 0) + 1; });
  const { count: draftsReady } = await db.from('blog_ideas').select('id', { count: 'exact', head: true }).eq('status', 'draft_ready');

  const aeo = await aeoSummary();
  const { data: plan } = await db.from('weekly_plans').select('*').order('week_of', { ascending: false }).limit(1).maybeSingle();
  if (plan && plan.items) {
    const ids = plan.items.filter((i) => i.ref_id && i.type === 'suggestion').map((i) => i.ref_id);
    const { data: st } = ids.length ? await db.from('suggestions').select('id,status').in('id', ids) : { data: [] };
    const sm = Object.fromEntries((st || []).map((x) => [x.id, x.status]));
    plan.items = plan.items.map((i) => ({ ...i, status: sm[i.ref_id] || null }));
  }
  const { data: alerts } = await db.from('alerts').select('*').eq('resolved', false).order('created_at', { ascending: false }).limit(10);
  const out = { connected: !!tok, last_date: last, runs: lastRuns, todo, drafts_ready: draftsReady || 0, aeo: aeo.summary, plan, alerts: alerts || [] };
  if (!last) return out;

  const { data: series } = await db.from('gsc_site_daily').select('*').gte('date', addDays(last, -55)).lte('date', last).order('date');
  const now = (series || []).filter((r) => r.date > addDays(last, -7));
  const prev = (series || []).filter((r) => r.date <= addDays(last, -7) && r.date > addDays(last, -14));
  out.week = { now: totals(now), prev: totals(prev), from: addDays(last, -6), to: last, prev_from: addDays(last, -13), prev_to: addDays(last, -7) };
  out.series = series;

  // impact of each change: 7 days before vs 7 days after (rolling until 7 days exist)
  const { data: changes } = await db.from('changes').select('*').gte('date', addDays(last, -75)).order('date', { ascending: false });
  out.changes = [];
  for (const c of changes || []) {
    const before = c.page_url ? await pageRange(c.page_url, addDays(c.date, -7), addDays(c.date, -1)) : totals((series || []).filter((r) => r.date >= addDays(c.date, -7) && r.date < c.date));
    const afterTo = addDays(c.date, 7) < last ? addDays(c.date, 7) : last;
    const after = c.date >= last ? { days: 0 } : c.page_url ? await pageRange(c.page_url, addDays(c.date, 1), afterTo) : totals((series || []).filter((r) => r.date > c.date && r.date <= afterTo));
    let verdict = 'too_early';
    if (after.days >= 3 && before.days) {
      const perDayB = before.clicks / before.days, perDayA = after.clicks / after.days;
      const ch = perDayB ? (perDayA - perDayB) / perDayB : perDayA > 0 ? 1 : 0;
      const posBetter = before.position && after.position ? before.position - after.position : 0;
      verdict = ch > 0.1 || (Math.abs(ch) <= 0.1 && posBetter > 0.5) ? 'positive' : ch < -0.1 || posBetter < -0.5 ? 'negative' : 'neutral';
      after.change = ch;
    }
    out.changes.push({ ...c, before, after, verdict, days_after: after.days || 0 });
  }

  // biggest movers this week vs last week
  const { data: mv } = await db.rpc('query_movers', { d_end: last, min_impr: 10 });
  const movers = (mv || []).map((m) => ({ ...m, delta: Number(m.pos_prev) - Number(m.pos_now) }));
  out.gainers = movers.filter((m) => m.delta > 0.4).sort((a, b) => b.delta * Math.log(b.impr_now + 1) - a.delta * Math.log(a.impr_now + 1)).slice(0, 6);
  out.losers = movers.filter((m) => m.delta < -0.4).sort((a, b) => a.delta * Math.log(a.impr_now + 1) - b.delta * Math.log(b.impr_now + 1)).slice(0, 6);

  const { data: pNow } = await db.rpc('page_window', { d_from: addDays(last, -6), d_to: last });
  const { data: pPrev } = await db.rpc('page_window', { d_from: addDays(last, -13), d_to: addDays(last, -7) });
  const prevMap = Object.fromEntries((pPrev || []).map((p) => [p.page, p]));
  out.pages = (pNow || []).map((p) => ({ page: p.page, clicks: Number(p.clicks), prev_clicks: Number((prevMap[p.page] || {}).clicks || 0), pos: Number(p.pos), prev_pos: prevMap[p.page] ? Number(prevMap[p.page].pos) : null, impressions: Number(p.impressions) }))
    .sort((a, b) => b.clicks - a.clicks).slice(0, 12);
  return out;
}

async function keywords() {
  const last = await latestDate();
  if (!last) return { rows: [] };
  const { data } = await db.rpc('kw_window', { d_from: addDays(last, -27), d_to: last, lim: 400 });
  return { from: addDays(last, -27), to: last, rows: (data || []).map((r) => ({ ...r, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.ctr), pos: Number(r.pos) })) };
}

async function pagesData() {
  const last = await latestDate();
  const { data: pages } = await db.from('pages').select('*').order('url');
  let metrics = {};
  if (last) {
    const { data: pw } = await db.rpc('page_window', { d_from: addDays(last, -27), d_to: last });
    metrics = Object.fromEntries((pw || []).map((p) => [p.page, p]));
  }
  const { count: imgs } = await db.from('images').select('src', { count: 'exact', head: true });
  const { count: noAlt } = await db.from('images').select('src', { count: 'exact', head: true }).eq('alt', '');
  return { pages: (pages || []).map((p) => ({ ...p, m: metrics[p.url] || null })), images: imgs || 0, images_no_alt: noAlt || 0 };
}

async function aeoSummary() {
  const { data: qs } = await db.from('aeo_questions').select('*').order('created_at');
  const { data: checks } = await db.from('aeo_checks').select('question_id,status,competitors,cited_urls,checked_at,answer').order('checked_at', { ascending: false }).limit(400);
  const hist = {};
  (checks || []).forEach((c) => { (hist[c.question_id] = hist[c.question_id] || []).push(c); });
  const rows = (qs || []).map((q) => ({ ...q, latest: (hist[q.id] || [])[0] || null, history: (hist[q.id] || []).slice(0, 6).map((h) => ({ status: h.status, at: h.checked_at })) }));
  const active = rows.filter((r) => r.active && r.latest && r.latest.status !== 'error');
  const comp = {};
  active.forEach((r) => (r.latest.competitors || []).forEach((c) => { comp[c] = (comp[c] || 0) + 1; }));
  return {
    rows,
    summary: { checked: active.length, cited: active.filter((r) => r.latest.status === 'cited').length, mentioned: active.filter((r) => ['cited', 'mentioned', 'source_only'].includes(r.latest.status)).length, competitors: Object.entries(comp).sort((a, b) => b[1] - a[1]).slice(0, 8) },
  };
}

async function sendToShopify(id) {
  const store = process.env.SHOPIFY_STORE, token = process.env.SHOPIFY_ADMIN_TOKEN, blogId = process.env.SHOPIFY_BLOG_ID;
  if (!store || !token || !blogId) throw new Error('Shopify isn\'t connected yet: add SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN and SHOPIFY_BLOG_ID in Netlify');
  const { data: b } = await db.from('blog_ideas').select('*').eq('id', id).single();
  const res = await fetch(`https://${store}/admin/api/${process.env.SHOPIFY_API_VERSION || '2025-10'}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: `mutation($a: ArticleCreateInput!){ articleCreate(article:$a){ article{ id handle } userErrors{ field message } } }`,
      variables: { a: { blogId, title: b.title, body: b.draft_html, isPublished: false, author: { name: 'Baboodle' },
        metafields: [{ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: b.meta_title || b.title }, { namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: b.meta_description || '' }] } },
    }),
  });
  const d = await res.json();
  const r = d.data && d.data.articleCreate;
  if (!r || (r.userErrors && r.userErrors.length)) throw new Error('Shopify: ' + JSON.stringify((r && r.userErrors) || d.errors || d));
  await db.from('blog_ideas').update({ status: 'in_shopify', shopify_article_id: r.article.id, updated_at: new Date().toISOString() }).eq('id', id);
  return r.article;
}

exports.handler = async (event) => {
  const key = event.headers['x-dash-key'];
  if (!process.env.DASHBOARD_PASSWORD || key !== process.env.DASHBOARD_PASSWORD) return json(401, { error: 'Wrong password' });
  const q = event.queryStringParameters || {};
  const action = q.action;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  try {
    if (event.httpMethod === 'GET') {
      if (action === 'overview') return json(200, await overview());
      if (action === 'keywords') return json(200, await keywords());
      if (action === 'pages') return json(200, await pagesData());
      if (action === 'aeo') return json(200, await aeoSummary());
      if (action === 'suggestions') {
        let qb = db.from('suggestions').select('*').order('created_at', { ascending: false }).limit(q.category === 'images' ? 300 : 150);
        if (q.category) qb = qb.eq('category', q.category);
        if (q.status) qb = qb.in('status', q.status.split(','));
        const { data } = await qb;
        return json(200, { rows: data || [] });
      }
      if (action === 'blogs') {
        const { data } = await db.from('blog_ideas').select('id,title,target_page,status,total_demand,expected_bookings,intent,cluster,outline,ranking,conversion,meta_title,meta_description,checks,created_at,strategy_score,strategy_note').order('strategy_score', { ascending: false, nullsFirst: false }).order('expected_bookings', { ascending: false, nullsFirst: false });
        return json(200, { rows: data || [] });
      }
      if (action === 'blog') {
        const { data } = await db.from('blog_ideas').select('*').eq('id', q.id).single();
        return json(200, data);
      }
      if (action === 'strategy') {
        const { data } = await db.from('settings').select('value,updated_at').eq('key', 'strategy').maybeSingle();
        return json(200, data || { value: '' });
      }
      if (action === 'chat') {
        const { data } = await db.from('chat_messages').select('id,role,content,status,created_at').eq('thread_id', q.thread_id).order('created_at').limit(100);
        return json(200, { rows: data || [] });
      }
      if (action === 'results') {
        const { data: done } = await db.from('suggestions').select('*').eq('status', 'done').order('actioned_at', { ascending: false }).limit(100);
        return json(200, { rows: done || [] });
      }
    }

    if (event.httpMethod === 'POST') {
      if (action === 'suggestion') {
        const patch = { status: body.status };
        if (body.proposed) patch.proposed = body.proposed;
        if (body.status === 'done') patch.actioned_at = new Date().toISOString();
        const { data: s } = await db.from('suggestions').update(patch).eq('id', body.id).select().single();
        if (body.status === 'done' && s && s.category !== 'images') {
          await db.from('changes').insert({ date: iso(new Date()), page_url: s.page_url, description: s.title, source: 'suggestion', suggestion_id: s.id });
        }
        return json(200, { ok: true });
      }
      if (action === 'change') {
        await db.from('changes').insert({ date: body.date || iso(new Date()), page_url: body.page_url || null, description: body.description, source: 'manual' });
        return json(200, { ok: true });
      }
      if (action === 'save-strategy') {
        await db.from('settings').upsert({ key: 'strategy', value: String(body.value || '').slice(0, 20000), updated_at: new Date().toISOString() });
        // re-score ideas and open tasks against the new strategy and rebuild this week's plan
        await db.from('blog_ideas').update({ strategy_score: null, strategy_note: null }).in('status', ['idea', 'draft_ready']);
        await db.from('suggestions').update({ strategy_score: null, strategy_note: null }).in('status', ['suggested', 'approved']).neq('category', 'images');
        const { data: busyA } = await db.from('runs').select('id').eq('job', 'analyze').eq('status', 'running').gte('started_at', new Date(Date.now() - 20 * 60000).toISOString()).limit(1);
        if (!(busyA && busyA.length)) await trigger('analyze-background', { only: 'plan' });
        return json(200, { ok: true, replanning: true });
      }
      if (action === 'chat-send') {
        const text = String(body.text || '').slice(0, 4000).trim();
        if (!text || !body.thread_id) return json(400, { error: 'Empty message' });
        await db.from('chat_messages').insert({ thread_id: body.thread_id, role: 'user', content: text });
        const { data: reply } = await db.from('chat_messages').insert({ thread_id: body.thread_id, role: 'assistant', content: 'Thinking…', status: 'pending' }).select('id').single();
        await trigger('chat-background', { thread_id: body.thread_id, reply_id: reply.id });
        return json(200, { ok: true, reply_id: reply.id });
      }
      if (action === 'resolve-alert') { await db.from('alerts').update({ resolved: true }).eq('id', body.id); return json(200, { ok: true }); }
      if (action === 'delete-change') { await db.from('changes').delete().eq('id', body.id); return json(200, { ok: true }); }
      if (action === 'run') {
        const jobs = { sync: ['gsc-sync-background', {}], backfill: ['gsc-sync-background', { days: 90 }], scan: ['site-scan-background', {}], aeo: ['aeo-check-background', {}], analyze: ['analyze-background', {}], plan: ['analyze-background', { only: 'plan' }], weekly: ['site-scan-background', { chain: true }] };
        const j = jobs[body.job];
        if (!j) return json(400, { error: 'Unknown job' });
        const busyJobs = body.job === 'weekly' ? ['site-scan', 'aeo-check', 'analyze'] : [j[0].replace('-background', '')];
        const { data: busy } = await db.from('runs').select('job').in('job', busyJobs).eq('status', 'running').gte('started_at', new Date(Date.now() - 25 * 60000).toISOString()).limit(1);
        if (busy && busy.length) return json(409, { error: 'That\'s already running. Give it a few minutes.' });
        await trigger(j[0], j[1]);
        return json(200, { ok: true });
      }
      if (action === 'write-draft') { await trigger('draft-blog-background', { id: body.id }); return json(200, { ok: true }); }
      if (action === 'save-blog') {
        const patch = {};
        ['meta_title', 'meta_description', 'draft_html', 'status', 'title'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
        patch.updated_at = new Date().toISOString();
        await db.from('blog_ideas').update(patch).eq('id', body.id);
        return json(200, { ok: true });
      }
      if (action === 'send-blog') return json(200, { ok: true, article: await sendToShopify(body.id) });
      if (action === 'question') {
        if (body.id) await db.from('aeo_questions').update({ active: !!body.active }).eq('id', body.id);
        else await db.from('aeo_questions').insert({ question: body.question });
        return json(200, { ok: true });
      }
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
