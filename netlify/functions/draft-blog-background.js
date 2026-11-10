// Writes a full blog draft for one blog idea, then runs checks (links, FAQ, FCA wording, overlaps, claims to verify).
const { db, json, isJobCall, startRun, endRun, claude, claudeText, parseJSON, MODEL_MAIN, BRAND_BRIEF } = require('../../lib/shared');

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  const { id } = JSON.parse(event.body || '{}');
  const run = await startRun('draft-blog');
  try {
    const { data: b } = await db.from('blog_ideas').select('*').eq('id', id).single();
    if (!b) throw new Error('Blog idea not found');
    await db.from('blog_ideas').update({ status: 'drafting', updated_at: new Date().toISOString() }).eq('id', id);

    const { data: blogs } = await db.from('pages').select('url,title').eq('page_type', 'blog');
    const { data: cols } = await db.from('pages').select('url,title').eq('page_type', 'collection').eq('status', 200);

    const resp = await claude({
      model: MODEL_MAIN, max_tokens: 12000,
      system: BRAND_BRIEF,
      messages: [{ role: 'user', content: `Write the full blog post for this plan.\nPLAN: ${JSON.stringify({ title: b.title, intent: b.intent, cluster: b.cluster, outline: b.outline, ranking: b.ranking, target_page: b.target_page, conversion: b.conversion })}\nBaboodle collection pages you can link to: ${JSON.stringify((cols || []).map((c) => c.url))}\nExisting blog posts: ${JSON.stringify(blogs || [])}\n\nRules: 1,200–1,800 words; H2s from the outline; answer each question directly in the first sentence of its section (good for Google and AI answers); link to ${b.target_page} at least twice and to relevant product/collection pages with natural anchor text; end with a FAQ section (4–6 Q&As) and a short call to action to hire; mark any product fact you are not certain of with [CHECK: ...]; no finance/credit claims, never "cheaper than buying".\nReply as JSON: {"meta_title":"≤60 chars","meta_description":"≤155 chars","html":"article body HTML using <h2>,<p>,<ul>,<a href>","faqs":[{"q":"","a":""}],"checks":[{"ok":true|false,"text":"..."}]} where checks cover: links to target page, FAQ present, FCA-safe wording, overlap with existing posts (name them), facts to verify.` }],
    });
    const d = parseJSON(claudeText(resp));
    const faqLd = d.faqs && d.faqs.length ? `\n<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: d.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) })}</script>` : '';
    await db.from('blog_ideas').update({
      status: 'draft_ready', meta_title: d.meta_title, meta_description: d.meta_description,
      draft_html: (d.html || '') + faqLd, checks: d.checks || [], updated_at: new Date().toISOString(),
    }).eq('id', id);
    await endRun(run, 'ok', b.title);
    return json(200, { ok: true });
  } catch (e) {
    await db.from('blog_ideas').update({ status: 'idea' }).eq('id', id);
    await endRun(run, 'error', e.message);
    return json(500, { error: e.message });
  }
};
