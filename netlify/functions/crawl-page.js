// netlify/functions/crawl-page.js
// Called when a user clicks "Actioned" on an SEO action
// Takes a before/after snapshot of the page's on-page elements

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function extractElements(html) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Extract meta description
  const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  const metaDescription = metaMatch ? metaMatch[1].trim() : null;

  // Extract H1
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : null;

  // Extract H2s
  const h2Matches = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  const h2s = h2Matches.map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);

  // Word count (strip HTML)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyText = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const wordCount = bodyText.split(' ').filter(w => w.length > 2).length;

  // Detect schema types
  const schemaMatches = [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)];
  const schemaTypes = [...new Set(schemaMatches.map(m => m[1]))];
  const hasFaqSchema = schemaTypes.includes('FAQPage');
  const hasOrgSchema = schemaTypes.includes('Organization') || schemaTypes.includes('LocalBusiness');

  // Count internal links
  const internalLinks = [...html.matchAll(/href=["'](\/[^"']*|https?:\/\/baboodle\.co\.uk[^"']*)["']/gi)];
  const internalLinkCount = internalLinks.length;

  // Hash the full HTML for change detection
  const rawHtmlHash = crypto.createHash('md5').update(html).digest('hex');

  return {
    title,
    meta_description: metaDescription,
    h1,
    h2s,
    word_count: wordCount,
    has_faq_schema: hasFaqSchema,
    has_org_schema: hasOrgSchema,
    schema_types: schemaTypes,
    internal_link_count: internalLinkCount,
    raw_html_hash: rawHtmlHash,
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { page_id, action_id, snapshot_type, url } = JSON.parse(event.body || '{}');

  if (!url || !page_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'url and page_id required' }) };
  }

  try {
    // Fetch the live page
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BaboodleSEOBot/1.0 (SEO Dashboard)' }
    });
    const html = await res.text();
    const elements = extractElements(html);

    // Save snapshot
    const { data: snapshot, error } = await supabase
      .from('page_snapshots')
      .insert({
        page_id,
        action_id: action_id || null,
        snapshot_type: snapshot_type || 'before',
        ...elements,
        crawled_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) throw error;

    // Update the page record with current values
    await supabase.from('pages').update({
      title: elements.title,
      meta_description: elements.meta_description,
      h1: elements.h1,
      word_count: elements.word_count,
      has_faq_schema: elements.has_faq_schema,
      has_org_schema: elements.has_org_schema,
      updated_at: new Date().toISOString(),
    }).eq('id', page_id);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, snapshot_id: snapshot.id, elements }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
