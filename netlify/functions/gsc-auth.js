// Connect Google Search Console (read-only) with the existing OAuth client.
// /api/gsc-auth?key=PASSWORD  → sends you to Google
// /auth/callback (rewritten here) → stores the tokens, starts the first sync
const crypto = require('crypto');
const { db, DASH_URL, trigger } = require('../../lib/shared');

const REDIRECT = `${DASH_URL}/auth/callback`;
const state = () => crypto.createHmac('sha256', process.env.JOB_SECRET || 'x').update('gsc-connect').digest('hex').slice(0, 32);
const redirect = (to) => ({ statusCode: 302, headers: { Location: to, 'Cache-Control': 'no-store' }, body: '' });

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  if (q.code) {
    if (q.state !== state()) return redirect('/?gsc=bad_state');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.code, client_id: process.env.GSC_CLIENT_ID, client_secret: process.env.GSC_CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    });
    const t = await res.json();
    if (!t.refresh_token) return redirect('/?gsc=' + encodeURIComponent(t.error_description || t.error || 'no_refresh_token'));
    await db.from('gsc_tokens').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('gsc_tokens').insert({
      access_token: t.access_token, refresh_token: t.refresh_token, scope: t.scope,
      expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
    });
    await trigger('gsc-sync-background', {});
    return redirect('/?gsc=connected');
  }

  if (q.error) return redirect('/?gsc=' + encodeURIComponent(q.error));
  if (q.key !== process.env.DASHBOARD_PASSWORD) return { statusCode: 401, body: 'Not allowed' };

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GSC_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly', access_type: 'offline', prompt: 'consent', state: state(),
  });
  return redirect(url);
};
