// Bulk "Apply to Shopify" for alt texts (or a list of suggestion ids). Runs in the background (up to 15 min).
const { db, json, isJobCall, startRun, endRun } = require('../../lib/shared');
const shop = require('../../lib/shopify');

const iso = (d) => d.toISOString().slice(0, 10);

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const run = await startRun('apply-shopify');
  let ok = 0, failed = 0;
  try {
    let q = db.from('suggestions').select('*').in('status', ['suggested', 'approved']).is('applied_at', null);
    if (body.ids && body.ids.length) q = q.in('id', body.ids);
    else q = q.eq('category', body.category || 'images');
    const { data: rows } = await q.limit(body.limit || 500);
    for (const s of rows || []) {
      try {
        const applied = await shop.applySuggestion(s);
        await db.from('suggestions').update({ status: 'done', actioned_at: new Date().toISOString(), applied, applied_at: new Date().toISOString(), apply_error: null }).eq('id', s.id);
        if (s.category !== 'images') await db.from('changes').insert({ date: iso(new Date()), page_url: s.page_url, description: 'Applied in Shopify: ' + s.title, source: 'shopify', suggestion_id: s.id });
        await db.from('my_week').update({ status: 'done', done_at: new Date().toISOString() }).eq('ref_id', s.id).eq('status', 'todo');
        ok++;
      } catch (e) {
        failed++;
        await db.from('suggestions').update({ apply_error: e.message.slice(0, 300) }).eq('id', s.id);
        if (/permission|not connected|login failed/i.test(e.message)) throw e; // no point carrying on
      }
    }
    if (ok && (body.category || 'images') === 'images' && !(body.ids && body.ids.length)) {
      await db.from('changes').insert({ date: iso(new Date()), page_url: null, description: `Alt text added to ${ok} images in Shopify`, source: 'shopify' });
    }
    await endRun(run, failed ? 'partial' : 'ok', `${ok} applied in Shopify${failed ? `, ${failed} couldn't be applied (see each item)` : ''}`);
    return json(200, { ok, failed });
  } catch (e) {
    await endRun(run, 'error', `${ok} applied, then stopped: ${e.message}`);
    return json(500, { error: e.message });
  }
};
