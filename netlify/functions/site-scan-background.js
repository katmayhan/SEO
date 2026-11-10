// Weekly crawl of baboodle.co.uk from its sitemap: titles, descriptions, headings,
// word counts, structured data, links and image alt text. Writes pages + images + technical issues.
const cheerio = require('cheerio');
const { db, SITE, json, toPath, isJobCall, startRun, endRun, trigger } = require('../../lib/shared');
const { siteAlerts } = require('../../lib/alerts');

const MAX_PAGES = 700;
const UA = 'BaboodleSearchBrain/1.0 (+https://baboodleseo.netlify.app)';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: res.status === 200 ? await res.text() : '' };
}

async function sitemapUrls() {
  const idx = await get(`${SITE}/sitemap.xml`);
  const subs = [...idx.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const urls = [];
  for (const s of subs) {
    if (/sitemap_.*\.xml/.test(s) || s.endsWith('.xml') || s.includes('sitemap')) {
      const sm = await get(s);
      urls.push(...[...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&')).filter((u) => !/\.(jpg|png|webp|gif)/i.test(u)));
    } else urls.push(s);
  }
  const order = (u) => (/\/collections\//.test(u) ? 0 : /\/pages\//.test(u) ? 1 : /\/blogs\//.test(u) ? 2 : /\/products\//.test(u) ? 3 : 4);
  return [...new Set(urls)].sort((a, b) => order(a) - order(b)).slice(0, MAX_PAGES);
}

function pageType(path) {
  if (path === '/') return 'home';
  const m = path.match(/^\/(collections|products|pages|blogs)\//);
  return m ? m[1].replace(/s$/, '') : 'other';
}

function analyse(url, html) {
  const $ = cheerio.load(html);
  const path = toPath(url);
  const title = $('title').first().text().trim();
  const meta = $('meta[name="description"]').attr('content') || '';
  const robots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const h1s = $('h1').map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
  const h2s = $('h2').map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).slice(0, 25);

  const schemaTypes = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const j = JSON.parse($(el).html());
      [].concat(j).forEach((x) => { if (x && x['@type']) schemaTypes.push([].concat(x['@type']).join('/')); if (x && x['@graph']) x['@graph'].forEach((g) => g['@type'] && schemaTypes.push(g['@type'])); });
    } catch (e) {}
  });

  const main = $('main').length ? $('main').first() : $('body');
  const mainClone = main.clone();
  mainClone.find('script,style,noscript,header,footer,nav,[class*="header"],[class*="footer"],[class*="drawer"],[class*="menu"]').remove();
  const words = mainClone.text().replace(/\s+/g, ' ').trim().split(' ').filter((w) => /[a-z]/i.test(w)).length;

  const links = new Set();
  mainClone.find('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const u = new URL(href, SITE);
      if (u.hostname.endsWith('baboodle.co.uk')) links.add(u.pathname.replace(/\/$/, '') || '/');
    } catch (e) {}
  });

  const imgs = [];
  mainClone.find('img').each((i, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!src || src.startsWith('data:')) return;
    src = src.split('?')[0].replace(/^\/\//, 'https://');
    imgs.push({ page_url: path, src, alt: ($(el).attr('alt') || '').trim() });
  });
  const uniqImgs = Object.values(Object.fromEntries(imgs.map((i) => [i.src, i])));

  const issues = [];
  const type = pageType(path);
  if (!title) issues.push({ sev: 'high', code: 'no_title', text: 'No page title' });
  else if (title.length > 65) issues.push({ sev: 'low', code: 'long_title', text: `Title is ${title.length} characters, Google cuts off around 60` });
  else if (title.length < 25) issues.push({ sev: 'medium', code: 'short_title', text: `Title is only ${title.length} characters` });
  if (!meta) issues.push({ sev: 'medium', code: 'no_meta', text: 'No Google description' });
  else if (meta.length > 165) issues.push({ sev: 'low', code: 'long_meta', text: `Description is ${meta.length} characters, Google cuts off around 155` });
  if (h1s.length === 0) issues.push({ sev: 'high', code: 'no_h1', text: 'No main heading (H1)' });
  if (h1s.length > 1) issues.push({ sev: 'medium', code: 'multi_h1', text: `${h1s.length} main headings (H1)` });
  if (h1s[0] && /^collection:/i.test(h1s[0])) issues.push({ sev: 'low', code: 'h1_prefix', text: 'Heading starts with hidden "Collection:"' });
  if (robots.includes('noindex')) issues.push({ sev: 'high', code: 'noindex', text: 'Page is set to noindex' });
  if (canonical && toPath(canonical) !== path.split('?')[0]) issues.push({ sev: 'medium', code: 'canonical', text: `Canonical points to ${toPath(canonical)}` });
  if (['collection', 'page', 'blog', 'home'].includes(type) && words < 250) issues.push({ sev: 'medium', code: 'thin', text: `Thin text: ${words} words` });
  const missingAlt = uniqImgs.filter((i) => !i.alt).length;
  if (missingAlt) issues.push({ sev: 'low', code: 'alt', text: `${missingAlt} image(s) without alt text` });
  if (['collection', 'blog'].includes(type) && !schemaTypes.some((t) => /FAQ/.test(t))) issues.push({ sev: 'low', code: 'no_faq', text: 'No FAQ data for Google / AI answers' });

  return {
    row: {
      url: path, page_type: type, status: 200, title, meta_description: meta, h1: h1s[0] || null, h2s, word_count: words,
      canonical, has_faq_schema: schemaTypes.some((t) => /FAQ/.test(t)), has_breadcrumb_schema: schemaTypes.some((t) => /Breadcrumb/.test(t)),
      schema_types: [...new Set(schemaTypes)], internal_links_out: links.size, img_count: uniqImgs.length, img_missing_alt: missingAlt,
      issues, last_scanned: new Date().toISOString(),
    },
    links: [...links],
    imgs: uniqImgs,
  };
}

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const run = await startRun('site-scan');
  try {
    const urls = await sitemapUrls();
    const rows = [], images = [], inbound = {};
    let i = 0;
    async function worker() {
      while (i < urls.length) {
        const url = urls[i++];
        try {
          const r = await get(url);
          if (r.status !== 200) {
            rows.push({ url: toPath(url), page_type: pageType(toPath(url)), status: r.status, issues: [{ sev: 'high', code: 'status', text: `Returns ${r.status}${r.location ? ' → ' + toPath(r.location) : ''} but is in the sitemap` }], last_scanned: new Date().toISOString() });
            continue;
          }
          const a = analyse(url, r.text);
          rows.push(a.row);
          images.push(...a.imgs);
          a.links.forEach((l) => { if (l !== a.row.url) inbound[l] = (inbound[l] || 0) + 1; });
        } catch (e) {
          rows.push({ url: toPath(url), status: 0, issues: [{ sev: 'medium', code: 'fetch', text: 'Could not load: ' + e.message }], last_scanned: new Date().toISOString() });
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));

    // duplicate titles / descriptions
    const byTitle = {}, byMeta = {};
    rows.forEach((r) => { if (r.title) (byTitle[r.title] = byTitle[r.title] || []).push(r); if (r.meta_description) (byMeta[r.meta_description] = byMeta[r.meta_description] || []).push(r); });
    Object.values(byTitle).filter((g) => g.length > 1).forEach((g) => g.forEach((r) => r.issues.push({ sev: 'medium', code: 'dup_title', text: `Same title as ${g.length - 1} other page(s)` })));
    Object.values(byMeta).filter((g) => g.length > 1).forEach((g) => g.forEach((r) => r.issues.push({ sev: 'low', code: 'dup_meta', text: `Same description as ${g.length - 1} other page(s)` })));
    rows.forEach((r) => {
      r.internal_links_in = inbound[r.url] || 0;
      if (r.status === 200 && ['collection', 'blog', 'page'].includes(r.page_type) && !r.internal_links_in) r.issues.push({ sev: 'low', code: 'orphan', text: 'No links to it from other pages\' content' });
    });

    for (let k = 0; k < rows.length; k += 300) {
      const { error } = await db.from('pages').upsert(rows.slice(k, k + 300));
      if (error) throw new Error('pages: ' + error.message);
    }
    await db.from('images').delete().neq('src', '');
    for (let k = 0; k < images.length; k += 500) await db.from('images').upsert(images.slice(k, k + 500));

    await siteAlerts();
    await endRun(run, 'ok', `Scanned ${rows.length} pages, ${images.length} images`);
    if (body.chain) await trigger('aeo-check-background', { chain: true });
    return json(200, { ok: true, pages: rows.length });
  } catch (e) {
    await endRun(run, 'error', e.message);
    if (body.chain) await trigger('aeo-check-background', { chain: true });
    return json(500, { error: e.message });
  }
};
