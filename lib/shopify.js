// Shopify Admin API helpers: token (static or client-credentials), apply alt text and SEO meta, undo.
const { db } = require('./shared');

const STORE = () => process.env.SHOPIFY_STORE || 'katie-hanton-2.myshopify.com';
const VERSION = () => process.env.SHOPIFY_API_VERSION || '2026-10';
const NEEDED = ['write_products', 'write_content', 'write_files'];

function configured() {
  return !!(process.env.SHOPIFY_ADMIN_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET));
}

// Static token (older admin-created apps, shpat_...) or Dev Dashboard client credentials (24h token, cached)
async function shopToken(force) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Shopify isn\'t connected yet. Add SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, in Netlify.');
  if (!force) {
    const { data } = await db.from('settings').select('value').eq('key', 'shopify_token').maybeSingle();
    if (data && data.value) {
      try { const t = JSON.parse(data.value); if (t.token && t.expires_at > Date.now() + 10 * 60000) return t.token; } catch (e) {}
    }
  }
  const res = await fetch(`https://${STORE()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.access_token) throw new Error('Shopify login failed: ' + (d.error_description || d.error || res.status) + '. Check the app is installed on the store and the Client ID/Secret are right.');
  const expires = Date.now() + ((d.expires_in || 86400) * 1000);
  await db.from('settings').upsert({ key: 'shopify_token', value: JSON.stringify({ token: d.access_token, expires_at: expires, scope: d.scope || '' }), updated_at: new Date().toISOString() });
  return d.access_token;
}

async function gql(query, variables, retry = true) {
  const token = await shopToken();
  const res = await fetch(`https://${STORE()}/admin/api/${VERSION()}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && retry && !process.env.SHOPIFY_ADMIN_TOKEN) { await shopToken(true); return gql(query, variables, false); }
  if (res.status === 429 && retry) { await new Promise((r) => setTimeout(r, 2000)); return gql(query, variables, false); }
  const d = await res.json().catch(() => ({}));
  if (d.errors) {
    const msg = JSON.stringify(d.errors);
    if (/access denied|ACCESS_DENIED|scope/i.test(msg)) throw new Error('Shopify said no: the app is missing a permission (needs ' + NEEDED.join(', ') + ').');
    throw new Error('Shopify: ' + msg.slice(0, 300));
  }
  // gentle on the rate limit
  const cost = d.extensions && d.extensions.cost && d.extensions.cost.throttleStatus;
  if (cost && cost.currentlyAvailable < 200) await new Promise((r) => setTimeout(r, 1500));
  return d.data;
}

function userErr(payload) {
  const e = payload && payload.userErrors && payload.userErrors.length ? payload.userErrors : null;
  if (e) throw new Error('Shopify: ' + e.map((x) => x.message).join('; '));
}

async function status() {
  if (!configured()) return { connected: false, reason: 'not_configured', needed: NEEDED };
  try {
    const d = await gql('{ shop { name } currentAppInstallation { accessScopes { handle } } }');
    const have = (d.currentAppInstallation.accessScopes || []).map((s) => s.handle);
    const missing = NEEDED.filter((s) => !have.includes(s));
    return { connected: true, shop: d.shop.name, scopes: have, missing, ok: !missing.length };
  } catch (e) { return { connected: false, reason: e.message, needed: NEEDED }; }
}

// ---------- Alt text ----------
const baseName = (u) => decodeURIComponent(String(u || '').split('?')[0].split('/').pop() || '');

async function findFile(src) {
  const name = baseName(src);
  if (!name) return null;
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  const same = (n) => baseName((n.image && n.image.url) || n.url).toLowerCase() === name.toLowerCase();
  // Shopify's file search needs the name unquoted; try exact filename first, then a plain search on the stem
  const tries = [`filename:${name.replace(/[\s"()]/g, '?')}`, stem.replace(/[_\-.]+/g, ' ').replace(/["()]/g, '').trim()];
  for (const q of tries) {
    const d = await gql(`query($q:String!){ files(first: 100, query: $q) { nodes { id alt fileStatus ... on MediaImage { image { url } } ... on GenericFile { url } } } }`, { q });
    const hit = ((d.files && d.files.nodes) || []).find(same);
    if (hit) return hit;
  }
  return null;
}

async function setAlt(src, alt) {
  const f = await findFile(src);
  if (!f) throw new Error('Couldn\'t find this image in Shopify Files (' + baseName(src) + '). It may be a collection image or come from an app.');
  if (f.fileStatus && f.fileStatus !== 'READY') throw new Error('Shopify is still processing this image, try again later.');
  const d = await gql(`mutation($f:[FileUpdateInput!]!){ fileUpdate(files:$f){ files { id alt } userErrors { field message } } }`, { f: [{ id: f.id, alt }] });
  userErr(d.fileUpdate);
  return { kind: 'file', id: f.id, old: { alt: f.alt || '' }, now: { alt } };
}

// ---------- SEO title / description ----------
function parsePath(pageUrl) {
  const p = String(pageUrl || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/$/, '');
  let m;
  if ((m = p.match(/^\/products\/([^/]+)$/))) return { kind: 'product', handle: m[1] };
  if ((m = p.match(/^\/collections\/([^/]+)$/))) return { kind: 'collection', handle: m[1] };
  if ((m = p.match(/^\/pages\/([^/]+)$/))) return { kind: 'page', handle: m[1] };
  if ((m = p.match(/^\/blogs\/([^/]+)\/([^/]+)$/))) return { kind: 'article', handle: m[2] };
  return null;
}

async function getSeo(target) {
  if (target.kind === 'product') {
    const d = await gql('query($h:String!){ x: productByIdentifier(identifier:{handle:$h}) { id seo { title description } } }', { h: target.handle });
    if (!d.x) throw new Error('Product not found: ' + target.handle);
    return { id: d.x.id, title: d.x.seo.title || '', description: d.x.seo.description || '' };
  }
  if (target.kind === 'collection') {
    const d = await gql('query($h:String!){ x: collectionByIdentifier(identifier:{handle:$h}) { id seo { title description } } }', { h: target.handle });
    if (!d.x) throw new Error('Collection not found: ' + target.handle);
    return { id: d.x.id, title: d.x.seo.title || '', description: d.x.seo.description || '' };
  }
  const field = target.kind === 'page' ? 'pages' : 'articles';
  const d = await gql(`query($q:String!){ x: ${field}(first: 1, query: $q) { nodes { id t: metafield(namespace:"global", key:"title_tag"){ value } m: metafield(namespace:"global", key:"description_tag"){ value } } } }`, { q: `handle:${target.handle}` });
  const n = d.x && d.x.nodes && d.x.nodes[0];
  if (!n) throw new Error((target.kind === 'page' ? 'Page' : 'Blog post') + ' not found: ' + target.handle);
  return { id: n.id, title: (n.t && n.t.value) || '', description: (n.m && n.m.value) || '' };
}

async function writeSeo(target, id, title, description) {
  const seo = {};
  if (title != null) seo.title = title;
  if (description != null) seo.description = description;
  if (target.kind === 'product') {
    const d = await gql('mutation($p:ProductUpdateInput!){ productUpdate(product:$p){ product { id } userErrors { field message } } }', { p: { id, seo } });
    return userErr(d.productUpdate);
  }
  if (target.kind === 'collection') {
    const d = await gql('mutation($c:CollectionUpdateInput!){ collectionUpdate(collection:$c){ collection { id } userErrors { field message } } }', { c: { id, seo } });
    return userErr(d.collectionUpdate);
  }
  const metafields = [];
  if (title != null) metafields.push({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: title });
  if (description != null) metafields.push({ namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: description });
  if (target.kind === 'page') {
    const d = await gql('mutation($id:ID!,$p:PageUpdateInput!){ pageUpdate(id:$id, page:$p){ page { id } userErrors { field message } } }', { id, p: { metafields } });
    return userErr(d.pageUpdate);
  }
  const d = await gql('mutation($id:ID!,$a:ArticleUpdateInput!){ articleUpdate(id:$id, article:$a){ article { id } userErrors { field message } } }', { id, a: { metafields } });
  return userErr(d.articleUpdate);
}

async function setSeo(pageUrl, title, description) {
  const target = parsePath(pageUrl);
  if (!target) throw new Error('This page type can\'t be updated automatically (' + (pageUrl || 'no page') + '). The homepage title is set in Online Store → Preferences.');
  if (title && title.length > 70) throw new Error('Title is ' + title.length + ' characters, keep it to 60–65.');
  const cur = await getSeo(target);
  await writeSeo(target, cur.id, title || null, description || null);
  return { kind: target.kind, handle: target.handle, id: cur.id, old: { title: cur.title, description: cur.description }, now: { title: title || cur.title, description: description || cur.description } };
}

async function undo(applied) {
  if (!applied) throw new Error('Nothing to undo');
  if (applied.kind === 'file') {
    const d = await gql(`mutation($f:[FileUpdateInput!]!){ fileUpdate(files:$f){ files { id } userErrors { field message } } }`, { f: [{ id: applied.id, alt: applied.old.alt || '' }] });
    return userErr(d.fileUpdate);
  }
  return writeSeo({ kind: applied.kind }, applied.id, applied.old.title, applied.old.description);
}

// Apply one suggestion; returns the record needed for undo
async function applySuggestion(s) {
  const p = s.proposed || {};
  if (s.category === 'images') {
    if (!p.src || !p.alt) throw new Error('No image or alt text on this suggestion');
    return setAlt(p.src, p.alt);
  }
  if (s.category === 'meta') {
    if (!p.title && !p.description) throw new Error('No proposed title or description on this suggestion');
    return setSeo(s.page_url, p.title, p.description);
  }
  throw new Error('Only alt text and meta titles/descriptions can be applied automatically');
}

module.exports = { configured, shopToken, gql, status, applySuggestion, undo, NEEDED, STORE, VERSION };
