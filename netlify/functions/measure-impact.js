// netlify/functions/measure-impact.js
// Runs daily via scheduled function
// For all actions in 'measuring' status, checks if measurement period is complete
// and asks Claude to summarise the impact

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getAverageMetrics(pageId, startDate, endDate) {
  const { data } = await supabase
    .from('gsc_metrics')
    .select('clicks, impressions, ctr, position')
    .eq('page_id', pageId)
    .gte('date', startDate)
    .lte('date', endDate);

  if (!data || data.length === 0) return null;

  const avg = (key) => data.reduce((sum, r) => sum + parseFloat(r[key] || 0), 0) / data.length;
  const total = (key) => data.reduce((sum, r) => sum + parseFloat(r[key] || 0), 0);

  return {
    avg_position: parseFloat(avg('position').toFixed(2)),
    avg_ctr: parseFloat(avg('ctr').toFixed(4)),
    total_clicks: Math.round(total('clicks')),
    total_impressions: Math.round(total('impressions')),
    days: data.length,
  };
}

async function generateImpactSummary(action, before, after) {
  const prompt = `You are an SEO analyst for Baboodle, a UK circular economy baby equipment rental platform.

An SEO change was made and we now have before/after data. Write a concise 2-3 sentence impact summary.

Action: ${action.title}
Description: ${action.description}
Expected impact: ${action.expected_impact}

Before (${before.days} days avg):
- Position: ${before.avg_position}
- CTR: ${(before.avg_ctr * 100).toFixed(2)}%
- Total clicks: ${before.total_clicks}
- Total impressions: ${before.total_impressions}

After (${after.days} days avg):
- Position: ${after.avg_position}
- CTR: ${(after.avg_ctr * 100).toFixed(2)}%
- Total clicks: ${after.total_clicks}
- Total impressions: ${after.total_impressions}

Write a factual, direct summary of what changed. If improvements happened, say so clearly. If not, say so honestly and suggest why. End with one next recommendation.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text || 'Impact analysis unavailable.';
}

exports.handler = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Find all actions currently in measuring state whose period has ended
    const { data: actions } = await supabase
      .from('seo_actions')
      .select('*, pages(url, full_url)')
      .eq('status', 'measuring')
      .lte('measurement_end_date', today);

    if (!actions || actions.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No actions ready for measurement' }) };
    }

    for (const action of actions) {
      // Get 28-day window before actioning
      const actionDate = new Date(action.actioned_at);
      const beforeEnd = new Date(actionDate);
      beforeEnd.setDate(beforeEnd.getDate() - 1);
      const beforeStart = new Date(actionDate);
      beforeStart.setDate(beforeStart.getDate() - 28);

      const before = await getAverageMetrics(
        action.page_id,
        beforeStart.toISOString().split('T')[0],
        beforeEnd.toISOString().split('T')[0]
      );

      const after = await getAverageMetrics(
        action.page_id,
        action.measurement_start_date,
        action.measurement_end_date
      );

      if (!before || !after) continue;

      const resultSummary = await generateImpactSummary(action, before, after);

      await supabase.from('seo_actions').update({
        status: 'complete',
        result_clicks_before: before.total_clicks,
        result_clicks_after: after.total_clicks,
        result_position_before: before.avg_position,
        result_position_after: after.avg_position,
        result_ctr_before: before.avg_ctr,
        result_ctr_after: after.avg_ctr,
        result_summary: resultSummary,
        updated_at: new Date().toISOString(),
      }).eq('id', action.id);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, measured: actions.length }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
