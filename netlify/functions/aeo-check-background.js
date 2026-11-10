// Weekly AI-answer check: asks Claude (with live web search) each parent question and
// records whether Baboodle is cited (linked), mentioned, or missing, and who is named instead.
const { db, json, isJobCall, startRun, endRun, trigger, claude, claudeText, parseJSON, MODEL_MAIN, MODEL_FAST } = require('../../lib/shared');

async function ask(question) {
  const resp = await claude({
    model: MODEL_MAIN,
    max_tokens: 1200,
    system: 'You are a helpful assistant answering a parent in the UK. Search the web when useful and recommend specific services or products by name where relevant. Keep it to a short, practical answer.',
    messages: [{ role: 'user', content: question }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'GB' } }],
  });
  const answer = claudeText(resp);
  const urls = new Set();
  for (const b of resp.content || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((r) => r.url && urls.add(r.url));
    if (b.type === 'text' && Array.isArray(b.citations)) b.citations.forEach((c) => c.url && urls.add(c.url));
  }
  return { answer, urls: [...urls] };
}

async function competitors(question, answer) {
  try {
    const r = await claude({
      model: MODEL_FAST,
      max_tokens: 300,
      messages: [{ role: 'user', content: `List the businesses or websites recommended in this answer (not product brands like Bugaboo unless they are being recommended as a place to rent/buy). Exclude Baboodle. Reply as JSON {"names":["..."]}.\n\nQuestion: ${question}\n\nAnswer:\n${answer}` }],
    });
    return (parseJSON(claudeText(r)).names || []).slice(0, 8);
  } catch (e) { return []; }
}

exports.handler = async (event) => {
  if (!isJobCall(event)) return json(401, { error: 'Not allowed' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const run = await startRun('aeo-check');
  let ok = 0, failed = 0;
  try {
    const { data: qs } = await db.from('aeo_questions').select('id, question').eq('active', true);
    for (const q of qs || []) {
      try {
        const { answer, urls } = await ask(q.question);
        const mentioned = /baboodle/i.test(answer);
        const cited = urls.some((u) => /baboodle\.co\.uk/i.test(u));
        const status = cited && mentioned ? 'cited' : mentioned ? 'mentioned' : cited ? 'source_only' : 'missing';
        const comps = await competitors(q.question, answer);
        await db.from('aeo_checks').insert({ question_id: q.id, status, answer: answer.slice(0, 6000), cited_urls: urls.slice(0, 20), competitors: comps });
        ok++;
      } catch (e) {
        failed++;
        await db.from('aeo_checks').insert({ question_id: q.id, status: 'error', answer: e.message });
      }
    }
    await endRun(run, failed ? 'partial' : 'ok', `${ok} questions checked${failed ? `, ${failed} failed` : ''}`);
  } catch (e) {
    await endRun(run, 'error', e.message);
  }
  if (body.chain) await trigger('analyze-background', {});
  return json(200, { ok, failed });
};
