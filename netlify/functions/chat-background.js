// "Ask Claude" chat: answers Katie's questions from the dashboard's live data (and the web when useful).
// Runs as a background function; the browser polls for the reply.
const { db, json, isJobCall, claude, MODEL_MAIN, BRAND_BRIEF } = require('../../lib/shared');

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(new Date(d).getTime() + n * 864e5));
async function lastDate() {
  const { data } = await db.from('gsc_site_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
  return data ? data.date : null;
}
const sum = (a, k) => a.reduce((s, r) => s + Number(r[k] || 0), 0);
const wpos = (a) => { const i = sum(a, 'impressions'); return i ? +(a.reduce((s, r) => s + Number(r.position) * r.impressions, 0) / i).toFixed(1) : null; };

const TOOLS = [
  { name: 'site_totals', description: 'Whole-site Google Search totals (clicks, impressions, CTR, average position) for two periods, plus daily figures. Use for "how are we doing", trends and drops.', input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Length of each period in days (default 7)' } } } },
  { name: 'search_keywords', description: 'Search queries from Google Search Console for a period: clicks, impressions, CTR, average position and the page Google shows. Optionally filter by text.', input_schema: { type: 'object', properties: { contains: { type: 'string' }, days: { type: 'integer', description: 'default 28' }, limit: { type: 'integer', description: 'default 40' }, min_position: { type: 'number' }, max_position: { type: 'number' } } } },
  { name: 'query_trend', description: 'Daily clicks, impressions and position for one exact search query.', input_schema: { type: 'object', properties: { query: { type: 'string' }, days: { type: 'integer', description: 'default 56' } }, required: ['query'] } },
  { name: 'page_performance', description: 'Search performance for one page path (e.g. /collections/pram-hire): totals for this period vs the previous one, and its top queries.', input_schema: { type: 'object', properties: { path: { type: 'string' }, days: { type: 'integer', description: 'default 28' } }, required: ['path'] } },
  { name: 'top_pages', description: 'Pages ranked by clicks for a period, with the previous period for comparison.', input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'default 28' }, limit: { type: 'integer' } } } },
  { name: 'page_scan', description: 'Latest crawl of a page on baboodle.co.uk: title, description, H1, H2s, word count, structured data, links in/out, missing alt text and issues. Use path "*" with an issue code (no_h1, thin, no_meta, long_title, dup_title, canonical, noindex, status, orphan, no_faq, alt) to list pages with that issue.', input_schema: { type: 'object', properties: { path: { type: 'string' }, issue_code: { type: 'string' } }, required: ['path'] } },
  { name: 'suggestions', description: 'Suggestions the dashboard has made (category: keywords, onpage, meta, technical, images, aeo; status: suggested, approved, done, dismissed), including measured results.', input_schema: { type: 'object', properties: { category: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'changes', description: 'Changes Katie has logged on the site, with 7 days before vs after clicks for that page.', input_schema: { type: 'object', properties: {} } },
  { name: 'ai_mentions', description: 'Latest AI-answer checks: for each parent question, whether Claude cited Baboodle, mentioned it, or named competitors instead.', input_schema: { type: 'object', properties: {} } },
  { name: 'blog_ideas', description: 'Blog ideas with their strategy, expected bookings and status, and this week\'s 3-hour plan.', input_schema: { type: 'object', properties: {} } },
];

async function runTool(name, input = {}) {
  const last = await lastDate();
  if (!last && ['site_totals', 'search_keywords', 'query_trend', 'page_performance', 'top_pages'].includes(name)) return { error: 'No Search Console data yet: Search Console needs connecting on the dashboard.' };
  switch (name) {
    case 'site_totals': {
      const d = input.days || 7;
      const { data } = await db.from('gsc_site_daily').select('*').gte('date', addDays(last, -2 * d + 1)).lte('date', last).order('date');
      const now = data.filter((r) => r.date > addDays(last, -d)), prev = data.filter((r) => r.date <= addDays(last, -d));
      const t = (a) => ({ from: a[0] && a[0].date, to: a[a.length - 1] && a[a.length - 1].date, clicks: sum(a, 'clicks'), impressions: sum(a, 'impressions'), ctr: +(sum(a, 'clicks') / Math.max(1, sum(a, 'impressions'))).toFixed(4), position: wpos(a) });
      return { latest_date: last, current: t(now), previous: t(prev), daily: data.map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, position: +Number(r.position).toFixed(1) })) };
    }
    case 'search_keywords': {
      const d = input.days || 28;
      const { data } = await db.rpc('kw_window', { d_from: addDays(last, -d + 1), d_to: last, lim: 3000 });
      let rows = (data || []).map((r) => ({ query: r.query, page: r.page, clicks: Number(r.clicks), impressions: Number(r.impressions), ctr: Number(r.ctr), position: Number(r.pos) }));
      if (input.contains) rows = rows.filter((r) => r.query.includes(input.contains.toLowerCase()));
      if (input.min_position) rows = rows.filter((r) => r.position >= input.min_position);
      if (input.max_position) rows = rows.filter((r) => r.position <= input.max_position);
      return { period: `${addDays(last, -d + 1)} to ${last}`, matches: rows.length, rows: rows.slice(0, input.limit || 40) };
    }
    case 'query_trend': {
      const { data } = await db.from('gsc_query_daily').select('date,page,clicks,impressions,position').eq('query', input.query.toLowerCase()).gte('date', addDays(last, -(input.days || 56))).order('date');
      return { query: input.query, rows: data || [] };
    }
    case 'page_performance': {
      const d = input.days || 28;
      const path = input.path.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '') || '/';
      const { data: rows } = await db.from('gsc_page_daily').select('date,clicks,impressions,position').eq('page', path).gte('date', addDays(last, -2 * d + 1));
      const now = (rows || []).filter((r) => r.date > addDays(last, -d)), prev = (rows || []).filter((r) => r.date <= addDays(last, -d));
      const { data: q } = await db.from('gsc_query_daily').select('query,clicks,impressions,position').eq('page', path).gte('date', addDays(last, -d + 1));
      const agg = {};
      (q || []).forEach((r) => { const a = (agg[r.query] = agg[r.query] || { query: r.query, clicks: 0, impressions: 0, pw: 0 }); a.clicks += r.clicks; a.impressions += r.impressions; a.pw += r.position * r.impressions; });
      const top = Object.values(agg).sort((a, b) => b.impressions - a.impressions).slice(0, 30).map((a) => ({ query: a.query, clicks: a.clicks, impressions: a.impressions, position: +(a.pw / a.impressions).toFixed(1) }));
      return { path, period_days: d, current: { clicks: sum(now, 'clicks'), impressions: sum(now, 'impressions'), position: wpos(now) }, previous: { clicks: sum(prev, 'clicks'), impressions: sum(prev, 'impressions'), position: wpos(prev) }, top_queries: top };
    }
    case 'top_pages': {
      const d = input.days || 28;
      const { data: a } = await db.rpc('page_window', { d_from: addDays(last, -d + 1), d_to: last });
      const { data: b } = await db.rpc('page_window', { d_from: addDays(last, -2 * d + 1), d_to: addDays(last, -d) });
      const pm = Object.fromEntries((b || []).map((x) => [x.page, x]));
      return (a || []).map((x) => ({ page: x.page, clicks: Number(x.clicks), impressions: Number(x.impressions), position: Number(x.pos), prev_clicks: Number((pm[x.page] || {}).clicks || 0), prev_position: pm[x.page] ? Number(pm[x.page].pos) : null }))
        .sort((x, y) => y.clicks - x.clicks).slice(0, input.limit || 25);
    }
    case 'page_scan': {
      if (input.path === '*') {
        let q = db.from('pages').select('url,page_type,title,h1,word_count,issues').limit(80);
        if (input.issue_code) q = q.contains('issues', [{ code: input.issue_code }]);
        const { data } = await q;
        return data || [];
      }
      const path = input.path.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '') || '/';
      const { data } = await db.from('pages').select('*').eq('url', path).maybeSingle();
      return data || { error: 'Not in the last site scan' };
    }
    case 'suggestions': {
      let q = db.from('suggestions').select('category,title,detail,page_url,priority,effort_minutes,status,proposed,actioned_at,result').order('created_at', { ascending: false }).limit(input.limit || 40);
      if (input.category) q = q.eq('category', input.category);
      if (input.status) q = q.eq('status', input.status);
      const { data } = await q;
      return data || [];
    }
    case 'changes': {
      const { data: ch } = await db.from('changes').select('date,page_url,description').order('date', { ascending: false }).limit(30);
      const out = [];
      for (const c of ch || []) {
        if (!c.page_url || !last) { out.push(c); continue; }
        const { data: r } = await db.from('gsc_page_daily').select('date,clicks,impressions,position').eq('page', c.page_url).gte('date', addDays(c.date, -7)).lte('date', addDays(c.date, 7));
        const b = (r || []).filter((x) => x.date < c.date), a = (r || []).filter((x) => x.date > c.date);
        out.push({ ...c, before_7d: { clicks: sum(b, 'clicks'), days: b.length, position: wpos(b) }, after_7d: { clicks: sum(a, 'clicks'), days: a.length, position: wpos(a) } });
      }
      return out;
    }
    case 'ai_mentions': {
      const { data: qs } = await db.from('aeo_questions').select('id,question').eq('active', true);
      const { data: cs } = await db.from('aeo_checks').select('question_id,status,competitors,cited_urls,checked_at').order('checked_at', { ascending: false }).limit(200);
      const latest = {};
      (cs || []).forEach((c) => { if (!latest[c.question_id]) latest[c.question_id] = c; });
      return (qs || []).map((q) => ({ question: q.question, ...(latest[q.id] || { status: 'not checked' }) }));
    }
    case 'blog_ideas': {
      const { data: b } = await db.from('blog_ideas').select('title,status,target_page,total_demand,expected_bookings,intent,cluster,ranking,conversion').order('expected_bookings', { ascending: false }).limit(15);
      const { data: p } = await db.from('weekly_plans').select('week_of,summary,items').order('week_of', { ascending: false }).limit(1).maybeSingle();
      return { blog_ideas: b || [], this_weeks_plan: p };
    }
  }
  return { error: 'Unknown tool' };
}

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  const { thread_id, reply_id } = JSON.parse(event.body || '{}');
  try {
    const { data: hist } = await db.from('chat_messages').select('role,content,status').eq('thread_id', thread_id).neq('id', reply_id).eq('status', 'done').order('created_at').limit(30);
    const messages = (hist || []).map((m) => ({ role: m.role, content: m.content }));
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
    const system = `${BRAND_BRIEF}

You are the assistant inside Baboodle's "search brain" SEO/AEO dashboard, talking to Katie (co-founder). Today is ${today}. She has about 3 hours a week for SEO and AEO, so be practical and prioritise.
Answer from the data: call the tools to look things up before answering anything about Baboodle's performance, pages or rankings, and quote the real numbers with their date range. Google Search Console data lags about 2 days. If the data can't answer it, say so plainly rather than guessing. Use web search for things outside Baboodle's data (what ranks now, Google updates, competitor pages).
Keep answers short and scannable: lead with the answer, then the evidence, then what to do (with rough minutes). British English, plain words, no SEO jargon without a short explanation. Use **bold** and simple lists; no tables wider than 4 columns.`;

    let answer = '';
    for (let turn = 0; turn < 8; turn++) {
      const resp = await claude({
        model: MODEL_MAIN, max_tokens: 2500, system, messages,
        tools: [...TOOLS, { type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'GB' } }],
      });
      messages.push({ role: 'assistant', content: resp.content });
      const uses = (resp.content || []).filter((b) => b.type === 'tool_use');
      answer = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (resp.stop_reason !== 'tool_use' || !uses.length) break;
      const results = [];
      for (const u of uses) {
        let out;
        try { out = await runTool(u.name, u.input); } catch (e) { out = { error: e.message }; }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 60000) });
      }
      messages.push({ role: 'user', content: results });
      await db.from('chat_messages').update({ content: 'Looking at the data…' }).eq('id', reply_id);
    }
    await db.from('chat_messages').update({ content: answer || 'Sorry, I couldn\'t find an answer to that.', status: 'done' }).eq('id', reply_id);
    return json(200, { ok: true });
  } catch (e) {
    await db.from('chat_messages').update({ content: 'Something went wrong: ' + e.message, status: 'error' }).eq('id', reply_id);
    return json(500, { error: e.message });
  }
};
