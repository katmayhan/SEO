// Shared helpers for the Baboodle search brain functions
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const SITE = 'https://baboodle.co.uk';
const GSC_PROPERTY = 'sc-domain:baboodle.co.uk';
const DASH_URL = process.env.DASHBOARD_URL || 'https://baboodleseo.netlify.app';
const MODEL_MAIN = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MODEL_FAST = process.env.CLAUDE_MODEL_FAST || 'claude-haiku-5-5';

function json(status, body, extra = {}) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }, body: JSON.stringify(body) };
}

function toPath(url) {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/\/$/, '') || '/') + (u.search || '');
  } catch (e) {
    return url;
  }
}

function isJobCall(event) {
  const key = event.headers['x-job-key'] || event.headers['X-Job-Key'];
  return !!process.env.JOB_SECRET && key === process.env.JOB_SECRET;
}

async function startRun(job) {
  const { data } = await db.from('runs').insert({ job, status: 'running' }).select('id').single();
  return data ? data.id : null;
}
async function endRun(id, status, message) {
  if (!id) return;
  await db.from('runs').update({ status, message: String(message || '').slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', id);
}

// Fire another background job (returns immediately; Netlify answers 202)
async function trigger(fn, body = {}) {
  await fetch(`${DASH_URL}/.netlify/functions/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-job-key': process.env.JOB_SECRET },
    body: JSON.stringify(body),
  });
}

// ---------- Google Search Console ----------
async function gscToken() {
  const { data: row } = await db.from('gsc_tokens').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (!row || !row.refresh_token) throw new Error('Search Console is not connected');
  if (row.access_token && new Date(row.expires_at) > new Date(Date.now() + 60000)) return row.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const t = await res.json();
  if (!t.access_token) throw new Error('Search Console sign-in has expired – reconnect it (' + (t.error_description || t.error || res.status) + ')');
  await db.from('gsc_tokens').update({
    access_token: t.access_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);
  return t.access_token;
}

async function gscQuery(token, body) {
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_PROPERTY)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error('Search Console: ' + data.error.message);
  return data.rows || [];
}

// ---------- Claude ----------
// Structured reply: Claude must answer by filling in this schema, so the result is always valid JSON.
async function claudeJSON({ model = MODEL_MAIN, system, messages, max_tokens = 8000, schema, name = 'submit' }) {
  const resp = await claude({ model, system, messages, max_tokens, tools: [{ name, description: 'Submit the answer', input_schema: schema }], tool_choice: { type: 'tool', name } });
  const use = (resp.content || []).find((b) => b.type === 'tool_use');
  if (!use) throw new Error('Claude did not return the expected structure' + (resp.stop_reason === 'max_tokens' ? ' (reply too long)' : ''));
  if (resp.stop_reason === 'max_tokens') throw new Error('Claude\'s reply was cut off (too long)');
  return use.input;
}

async function claude({ model = MODEL_MAIN, system, messages, max_tokens = 4000, tools, tool_choice }) {
  // Server tools (web search) can pause a long turn: keep going until Claude finishes.
  let msgs = messages, content = [], data;
  for (let i = 0; i < 6; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, system, messages: msgs, max_tokens, ...(tools ? { tools } : {}), ...(tool_choice ? { tool_choice } : {}) }),
    });
    data = await res.json();
    if (data.error) throw new Error('Claude: ' + (data.error.message || JSON.stringify(data.error)));
    content = content.concat(data.content || []);
    if (data.stop_reason !== 'pause_turn') break;
    msgs = [...msgs, { role: 'assistant', content: data.content }];
  }
  return { ...data, content };
}
function claudeText(resp) {
  // text blocks split by citations belong together, so join without separators
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
function parseJSON(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) {}
  }
  throw new Error('Claude replied without valid JSON (it may have been cut off)');
}

const BRAND_BRIEF = `Baboodle (baboodle.co.uk) is a UK circular subscription rental and resale business for premium baby and family equipment: prams and pushchairs (Bugaboo, Stokke YOYO, Joolz, Cybex, UPPAbaby, iCandy), travel prams, double prams, running and off-road prams, cribs and bedside cribs (incl. Snoo), cots, travel cots, carriers, feeding and play equipment, plus kids bikes.
Customers rent monthly (flexible, swap as baby grows) or for short trips (holiday hire). UK-wide delivery, same-day London collection, free returns, 25,000+ customers, FCA authorised.
Key pages: hub /collections/pram-hire; sub-pages /collections/travel-prams, /collections/pram-hire-london, /collections/double-prams, /collections/off-road-prams, /collections/all-terrain-prams, /collections/city-prams, /collections/running-prams; /collections/cribs, /collections/cots, /collections/carriers, /collections/travel.
Tone: warm, honest, practical, British English, written like a parent who has been there. Never make finance or credit claims, never say renting is "cheaper than buying" or compare cost of credit (FCA). No made-up statistics or product specs: flag anything that needs checking.`;

// Katie's strategy (editable in the dashboard's Strategy tab), added to every Claude prompt
async function strategyBrief() {
  const { data } = await db.from('settings').select('value').eq('key', 'strategy').maybeSingle();
  if (!data || !data.value) return BRAND_BRIEF;
  return `${BRAND_BRIEF}\n\nBABOODLE'S CURRENT STRATEGY (set by Katie – weight everything towards this; favour work that moves the long-term strategy over one-off traffic; skip or deprioritise anything it says not to push, even if the search numbers are big; when an opportunity conflicts with the strategy, say so):\n${data.value}`;
}

module.exports = { strategyBrief, db, SITE, GSC_PROPERTY, DASH_URL, MODEL_MAIN, MODEL_FAST, json, toPath, isJobCall, startRun, endRun, trigger, gscToken, gscQuery, claude, claudeJSON, claudeText, parseJSON, BRAND_BRIEF };
