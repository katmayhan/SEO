// netlify/functions/gsc-sync.js
// Runs daily via Netlify scheduled function
// Pulls GSC data into Supabase for all tracked pages

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SITE_URL = 'https://baboodle.co.uk/';
const GSC_API = 'https://www.googleapis.com/webmasters/v3';

async function getAccessToken() {
  const { data: tokenRow } = await supabase
    .from('gsc_tokens')
    .select('*')
    .single();

  if (!tokenRow) throw new Error('No GSC tokens found — please authenticate first');

  // Refresh if expired
  if (new Date(tokenRow.expires_at) < new Date(Date.now() + 60000)) {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tokenRow.refresh_token,
        client_id: process.env.GSC_CLIENT_ID,
        client_secret: process.env.GSC_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const tokens = await tokenRes.json();
    await supabase.from('gsc_tokens').update({
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', tokenRow.id);
    return tokens.access_token;
  }

  return tokenRow.access_token;
}

async function gscRequest(accessToken, endpoint, body) {
  const res = await fetch(`${GSC_API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function syncPageMetrics(accessToken, date) {
  // Pull top 500 pages for the date
  const data = await gscRequest(accessToken, `/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`, {
    startDate: date,
    endDate: date,
    dimensions: ['page'],
    rowLimit: 500,
  });

  if (!data.rows) return;

  for (const row of data.rows) {
    const url = row.keys[0];
    const path = url.replace('https://baboodle.co.uk', '') || '/';

    // Upsert page record
    const { data: page } = await supabase
      .from('pages')
      .upsert({ url: path, full_url: url, updated_at: new Date().toISOString() }, { onConflict: 'url' })
      .select('id')
      .single();

    if (!page) continue;

    // Upsert daily metrics
    await supabase.from('gsc_metrics').upsert({
      page_id: page.id,
      date,
      clicks: Math.round(row.clicks),
      impressions: Math.round(row.impressions),
      ctr: parseFloat(row.ctr.toFixed(4)),
      position: parseFloat(row.position.toFixed(2)),
    }, { onConflict: 'page_id,date' });
  }
}

async function syncQueryData(accessToken, date) {
  // Pull top queries per page
  const data = await gscRequest(accessToken, `/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`, {
    startDate: date,
    endDate: date,
    dimensions: ['page', 'query'],
    rowLimit: 5000,
  });

  if (!data.rows) return;

  for (const row of data.rows) {
    const url = row.keys[0];
    const query = row.keys[1];
    const path = url.replace('https://baboodle.co.uk', '') || '/';

    const { data: page } = await supabase
      .from('pages')
      .select('id')
      .eq('url', path)
      .single();

    if (!page) continue;

    await supabase.from('gsc_queries').upsert({
      page_id: page.id,
      date,
      query,
      clicks: Math.round(row.clicks),
      impressions: Math.round(row.impressions),
      ctr: parseFloat(row.ctr.toFixed(4)),
      position: parseFloat(row.position.toFixed(2)),
    }, { onConflict: 'page_id,date,query' });
  }
}

exports.handler = async () => {
  try {
    const accessToken = await getAccessToken();

    // Sync yesterday's data (GSC data is typically 2-3 days delayed, sync last 3 days)
    const dates = [];
    for (let i = 2; i <= 4; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    for (const date of dates) {
      await syncPageMetrics(accessToken, date);
      await syncQueryData(accessToken, date);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: `Synced GSC data for ${dates.join(', ')}` }),
    };
  } catch (err) {
    console.error('GSC sync error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
