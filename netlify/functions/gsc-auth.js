// netlify/functions/gsc-auth.js
// Handles Google Search Console OAuth flow
// Exchanges auth code for tokens and stores in Supabase

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { action, code } = JSON.parse(event.body || '{}');

  // ── Step 1: Return the OAuth URL for the frontend to redirect to ──
  if (action === 'get_auth_url') {
    const params = new URLSearchParams({
      client_id: process.env.GSC_CLIENT_ID,
      redirect_uri: `${process.env.DASHBOARD_URL}/auth/callback`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      access_type: 'offline',
      prompt: 'consent',
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      }),
    };
  }

  // ── Step 2: Exchange auth code for tokens ──
  if (action === 'exchange_code' && code) {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GSC_CLIENT_ID,
        client_secret: process.env.GSC_CLIENT_SECRET,
        redirect_uri: `${process.env.DASHBOARD_URL}/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: tokens.error_description }),
      };
    }

    // Store tokens in Supabase
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const { error } = await supabase.from('gsc_tokens').upsert({
      id: '00000000-0000-0000-0000-000000000001', // single row
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt.toISOString(),
      scope: tokens.scope,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── Step 3: Refresh access token ──
  if (action === 'refresh_token') {
    const { data: tokenRow } = await supabase
      .from('gsc_tokens')
      .select('refresh_token')
      .single();

    if (!tokenRow?.refresh_token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'No refresh token' }) };
    }

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
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await supabase.from('gsc_tokens').update({
      access_token: tokens.access_token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', '00000000-0000-0000-0000-000000000001');

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
