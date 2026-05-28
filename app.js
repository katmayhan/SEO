
// ─── Config ───────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://grczjxrpjhzsbojjgnmz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdyY3pqeHJwamh6c2Jvampnbm16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5NzMzMzcsImV4cCI6MjA5NTU0OTMzN30.95Wc8KGshcDcnKUtf5x0DFzqqwEaYqsxdvDE5wXDie4';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentActionFilter = 'all';

// ─── Init ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Check for OAuth callback code in URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('code')) {
    document.getElementById('authScreen').style.display = 'block';
    document.getElementById('authScreen').querySelector('p').textContent = 'Connecting to Google Search Console...';
    await handleAuthCallback(params.get('code'));
    window.history.replaceState({}, '', '/');
  }

  // Check if we have tokens
  let hasTokens = false;
  try { 
    const { data } = await supabase.from('gsc_tokens').select('id').limit(1);
    hasTokens = data && data.length > 0;
  } catch(e) { 
    hasTokens = false; 
  }

  if (hasTokens) {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadOverview();
    loadPages();
    loadActions();
    loadContent();
    loadAEO();
  } else {
    document.getElementById('authScreen').style.display = 'block';
  }
});

async function checkGSCTokens() {
  const { data } = await supabase.from('gsc_tokens').select('id').single();
  return !!data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────
async function startAuth() {
  const res = await fetch('/api/gsc-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_auth_url' }),
  });
  const { url } = await res.json();
  window.location.href = url;
}

async function handleAuthCallback(code) {
  await fetch('/api/gsc-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'exchange_code', code }),
  });
}

// ─── Overview ─────────────────────────────────────────────────────────────
async function loadOverview() {
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateStr = thirtyDaysAgo.toISOString().split('T')[0];

  const { data: metrics } = await supabase
    .from('gsc_metrics')
    .select('clicks, impressions, ctr, position')
    .gte('date', dateStr);

  if (!metrics || metrics.length === 0) {
    document.getElementById('overviewMetrics').innerHTML = '<div class="empty">No data yet — trigger a GSC sync in Settings</div>';
    return;
  }

  const totalClicks = metrics.reduce((s, r) => s + r.clicks, 0);
  const totalImpr = metrics.reduce((s, r) => s + r.impressions, 0);
  const avgCtr = (metrics.reduce((s, r) => s + parseFloat(r.ctr), 0) / metrics.length * 100).toFixed(1);
  const avgPos = (metrics.reduce((s, r) => s + parseFloat(r.position), 0) / metrics.length).toFixed(1);

  document.getElementById('overviewMetrics').innerHTML = `
    <div class="metric"><div class="metric-label">Clicks / 30d</div><div class="metric-value">${totalClicks.toLocaleString()}</div></div>
    <div class="metric"><div class="metric-label">Impressions / 30d</div><div class="metric-value">${totalImpr.toLocaleString()}</div></div>
    <div class="metric"><div class="metric-label">Avg position</div><div class="metric-value">${avgPos}</div></div>
    <div class="metric"><div class="metric-label">Avg CTR</div><div class="metric-value">${avgCtr}%</div></div>
  `;

  // Top pages
  const { data: pages } = await supabase
    .from('gsc_metrics')
    .select('page_id, clicks, pages(url)')
    .gte('date', dateStr)
    .order('clicks', { ascending: false })
    .limit(50);

  // Aggregate by page
  const pageMap = {};
  (pages || []).forEach(r => {
    const url = r.pages?.url || '?';
    pageMap[url] = (pageMap[url] || 0) + r.clicks;
  });
  const topPages = Object.entries(pageMap).sort((a,b) => b[1]-a[1]).slice(0,6);
  const maxClicks = topPages[0]?.[1] || 1;

  document.getElementById('topPages').innerHTML = topPages.map(([url, clicks]) => `
    <div class="bar-row">
      <div class="bar-label" title="${url}">${url}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(clicks/maxClicks*100)}%"></div></div>
      <div class="bar-val">${clicks.toLocaleString()}</div>
    </div>
  `).join('') || '<div class="empty">No data yet</div>';

  // Opportunities — pages with high impressions but low CTR
  const { data: allMetrics } = await supabase
    .from('gsc_metrics')
    .select('page_id, clicks, impressions, ctr, position, pages(url)')
    .gte('date', dateStr);

  const pageAgg = {};
  (allMetrics || []).forEach(r => {
    const url = r.pages?.url || '?';
    if (!pageAgg[url]) pageAgg[url] = { clicks: 0, impressions: 0, position: [], ctr: [] };
    pageAgg[url].clicks += r.clicks;
    pageAgg[url].impressions += r.impressions;
    pageAgg[url].position.push(parseFloat(r.position));
    pageAgg[url].ctr.push(parseFloat(r.ctr));
  });

  const opps = Object.entries(pageAgg)
    .map(([url, d]) => ({
      url,
      impressions: d.impressions,
      ctr: d.ctr.reduce((s,v)=>s+v,0)/d.ctr.length,
      position: d.position.reduce((s,v)=>s+v,0)/d.position.length,
    }))
    .filter(p => p.impressions > 100 && p.ctr < 0.04 && p.position < 20)
    .sort((a,b) => b.impressions - a.impressions)
    .slice(0, 5);

  document.getElementById('opportunities').innerHTML = opps.map(p => `
    <div style="display:flex; align-items:center; gap:10px; padding: 8px 0; border-bottom: 0.5px solid var(--border);">
      <div style="flex:1; min-width:0;">
        <div class="mono" style="font-size:12px; color:var(--text);">${p.url}</div>
        <div style="font-size:11px; color:var(--text3); margin-top:2px;">${p.impressions.toLocaleString()} impressions · pos ${p.position.toFixed(1)}</div>
      </div>
      <span class="badge b-red">${(p.ctr*100).toFixed(1)}% CTR</span>
    </div>
  `).join('') || '<div class="empty">No low-CTR opportunities found</div>';

  // AI analysis
  runAIAnalysis('overview', { totalClicks, totalImpr, avgCtr, avgPos, topPages: topPages.slice(0,3), opportunities: opps.slice(0,3) });
}

// ─── Pages ────────────────────────────────────────────────────────────────
async function loadPages() {
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateStr = thirtyDaysAgo.toISOString().split('T')[0];

  const { data: metrics } = await supabase
    .from('gsc_metrics')
    .select('page_id, clicks, impressions, ctr, position, pages(id, url, title, has_faq_schema)')
    .gte('date', dateStr);

  if (!metrics || metrics.length === 0) {
    document.getElementById('pagesBody').innerHTML = '<tr><td colspan="7" class="empty">No page data yet — run a GSC sync</td></tr>';
    return;
  }

  // Aggregate
  const pageMap = {};
  metrics.forEach(r => {
    const pid = r.page_id;
    if (!pageMap[pid]) pageMap[pid] = { ...r.pages, clicks:0, impressions:0, positions:[], ctrs:[] };
    pageMap[pid].clicks += r.clicks;
    pageMap[pid].impressions += r.impressions;
    pageMap[pid].positions.push(parseFloat(r.position));
    pageMap[pid].ctrs.push(parseFloat(r.ctr));
  });

  const pages = Object.values(pageMap).map(p => ({
    ...p,
    avgPos: p.positions.reduce((s,v)=>s+v,0)/p.positions.length,
    avgCtr: p.ctrs.reduce((s,v)=>s+v,0)/p.ctrs.length,
    score: calcScore(p),
  })).sort((a,b) => b.clicks - a.clicks);

  document.getElementById('pagesBody').innerHTML = pages.map(p => {
    const sc = p.score >= 65 ? 'score-g' : p.score >= 40 ? 'score-a' : 'score-r';
    const pri = p.score < 40 ? '<span class="badge b-red">High priority</span>' : p.score < 65 ? '<span class="badge b-amber">Medium</span>' : '<span class="badge b-green">On track</span>';
    return `<tr onclick="openPageDetail('${p.id}','${p.url}')">
      <td><span class="mono">${p.url}</span></td>
      <td><div class="score ${sc}">${p.score}</div></td>
      <td>${p.clicks.toLocaleString()}</td>
      <td>${p.impressions.toLocaleString()}</td>
      <td>${p.avgPos.toFixed(1)}</td>
      <td>${(p.avgCtr*100).toFixed(1)}%</td>
      <td>${pri}</td>
    </tr>`;
  }).join('');
}

function calcScore(p) {
  let score = 50;
  if (p.avgPos < 5) score += 25;
  else if (p.avgPos < 10) score += 15;
  else if (p.avgPos < 20) score += 5;
  else score -= 10;
  if (p.avgCtr > 0.06) score += 15;
  else if (p.avgCtr > 0.03) score += 5;
  else score -= 10;
  if (p.has_faq_schema) score += 10;
  if (p.title) score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Page Detail Panel ────────────────────────────────────────────────────
async function openPageDetail(pageId, url) {
  document.getElementById('overlay').classList.add('show');
  document.getElementById('detailPanel').classList.add('open');
  const el = document.getElementById('detailContent');
  el.innerHTML = `<h2 style="font-size:16px; font-weight:600; margin-bottom:4px; padding-right:32px;">${url}</h2>
    <p style="font-size:12px; color:var(--text3); margin-bottom:20px;">baboodle.co.uk${url}</p>
    <div class="loading">Loading query data...</div>`;

  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: queries } = await supabase
    .from('gsc_queries')
    .select('query, clicks, impressions, ctr, position')
    .eq('page_id', pageId)
    .gte('date', thirtyDaysAgo.toISOString().split('T')[0])
    .order('impressions', { ascending: false })
    .limit(30);

  // Aggregate queries
  const qMap = {};
  (queries || []).forEach(r => {
    if (!qMap[r.query]) qMap[r.query] = { clicks:0, impressions:0, positions:[], ctrs:[] };
    qMap[r.query].clicks += r.clicks;
    qMap[r.query].impressions += r.impressions;
    qMap[r.query].positions.push(parseFloat(r.position));
    qMap[r.query].ctrs.push(parseFloat(r.ctr));
  });

  const topQueries = Object.entries(qMap)
    .map(([q, d]) => ({ q, ...d, avgPos: d.positions.reduce((s,v)=>s+v,0)/d.positions.length, avgCtr: d.ctrs.reduce((s,v)=>s+v,0)/d.ctrs.length }))
    .sort((a,b) => b.impressions - a.impressions);

  const maxImpr = topQueries[0]?.impressions || 1;

  el.innerHTML = `
    <h2 style="font-size:16px; font-weight:600; margin-bottom:4px; padding-right:32px;">${url}</h2>
    <p style="font-size:12px; color:var(--text3); margin-bottom:20px;">baboodle.co.uk${url}</p>
    
    <div class="ai-panel" style="margin-bottom:16px;">
      <div class="ai-header"><div class="ai-dot"></div> AI recommendations for this page</div>
      <div class="ai-content ai-loading" id="pageAI">Analysing queries and generating recommendations...</div>
    </div>

    <div style="font-size:12px; font-weight:500; color:var(--text3); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:12px;">
      Search queries driving traffic — last 30 days
    </div>
    <div style="display:grid; grid-template-columns: 1fr 60px 60px 60px; gap:4px; font-size:11px; color:var(--text3); padding: 0 0 8px; border-bottom: 0.5px solid var(--border); margin-bottom:8px;">
      <div>Query</div><div style="text-align:right;">Clicks</div><div style="text-align:right;">Impr</div><div style="text-align:right;">Pos</div>
    </div>
    ${topQueries.length ? topQueries.map(q => `
      <div style="display:grid; grid-template-columns:1fr 60px 60px 60px; gap:4px; padding: 7px 0; border-bottom: 0.5px solid var(--border);">
        <div>
          <div style="font-size:13px; color:var(--text);">${q.q}</div>
          <div style="height:3px; background:var(--surface2); border-radius:2px; margin-top:4px; overflow:hidden;">
            <div style="height:100%; border-radius:2px; background:var(--blue); width:${Math.round(q.impressions/maxImpr*100)}%"></div>
          </div>
        </div>
        <div style="text-align:right; font-size:13px; color:var(--text2);">${q.clicks}</div>
        <div style="text-align:right; font-size:13px; color:var(--text2);">${q.impressions}</div>
        <div style="text-align:right; font-size:13px; color:var(--text2);">${q.avgPos.toFixed(1)}</div>
      </div>
    `).join('') : '<div class="empty">No query data for this page yet</div>'}

    <div style="margin-top:20px; display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="addPageAction('${pageId}','${url}')">+ Add to action plan</button>
      <button class="btn" onclick="generatePageBrief('${url}', ${JSON.stringify(topQueries.slice(0,5)).replace(/'/g,"&#39;")})">Generate content brief</button>
    </div>
  `;

  // Run AI analysis for this page
  runPageAI(pageId, url, topQueries.slice(0, 10));
}

async function runPageAI(pageId, url, queries) {
  const queryList = queries.map(q => `- "${q.q}": ${q.impressions} impressions, ${q.clicks} clicks, pos ${q.avgPos.toFixed(1)}, CTR ${(q.avgCtr*100).toFixed(1)}%`).join('\n');
  
  const prompt = `You are an SEO expert for Baboodle, a UK circular economy baby equipment rental platform at baboodle.co.uk.

Analyse this page's search query data and give 3-4 specific, actionable recommendations to improve rankings and CTR.

Page: ${url}

Top search queries (last 30 days):
${queryList || 'No query data available yet'}

Focus on:
1. Are people searching queries this page isn't well-optimised for?
2. Which queries have high impressions but low CTR — what would fix this?
3. What content additions would help this page rank better?
4. Any quick wins (title tag, meta description, schema)?

Be specific and direct. No fluff.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || 'Analysis unavailable.';
    const el = document.getElementById('pageAI');
    if (el) el.innerHTML = text.replace(/\n/g, '<br>');
  } catch (e) {
    const el = document.getElementById('pageAI');
    if (el) el.innerHTML = 'AI analysis unavailable — check Anthropic API key.';
  }
}

function closeDetail() {
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('detailPanel').classList.remove('open');
}

// ─── Actions ──────────────────────────────────────────────────────────────
async function loadActions() {
  const { data: actions } = await supabase
    .from('seo_actions')
    .select('*, pages(url)')
    .order('created_at', { ascending: false });

  renderActions(actions || []);
}

function renderActions(actions) {
  const filter = currentActionFilter;
  const filtered = filter === 'all' ? actions : actions.filter(a => a.status === filter);

  const total = actions.length;
  const complete = actions.filter(a => a.status === 'complete').length;
  document.getElementById('actionsProgress').textContent = `${complete} of ${total} actions complete`;

  if (filtered.length === 0) {
    document.getElementById('actionsList').innerHTML = `<div class="empty">No ${filter === 'all' ? '' : filter + ' '}actions yet — click "Generate new actions" to get AI recommendations</div>`;
    return;
  }

  document.getElementById('actionsList').innerHTML = filtered.map(a => {
    const statusDot = `<div class="status-dot s-${a.status}"></div>`;
    const statusBadge = {
      suggested: '<span class="badge b-gray">Suggested</span>',
      planned: '<span class="badge b-blue">Planned</span>',
      actioned: '<span class="badge b-amber">Actioned</span>',
      measuring: '<span class="badge b-amber">Measuring...</span>',
      complete: '<span class="badge b-green">Complete</span>',
      dismissed: '<span class="badge b-gray">Dismissed</span>',
    }[a.status] || '';

    const priorityBadge = a.priority === 'high' ? '<span class="badge b-red">High</span>' : a.priority === 'medium' ? '<span class="badge b-amber">Medium</span>' : '<span class="badge b-gray">Low</span>';

    let resultHtml = '';
    if (a.status === 'complete' && a.result_summary) {
      const posImproved = a.result_position_after < a.result_position_before;
      resultHtml = `<div class="result-card ${posImproved ? '' : 'neutral'}">
        <div class="result-stats">
          <div class="result-stat"><div class="val">${a.result_position_before?.toFixed(1)} → ${a.result_position_after?.toFixed(1)}</div><div class="lbl">Position</div></div>
          <div class="result-stat"><div class="val">${(a.result_ctr_before*100)?.toFixed(1)}% → ${(a.result_ctr_after*100)?.toFixed(1)}%</div><div class="lbl">CTR</div></div>
          <div class="result-stat"><div class="val">${a.result_clicks_before} → ${a.result_clicks_after}</div><div class="lbl">Clicks</div></div>
        </div>
        <div class="result-text">${a.result_summary}</div>
      </div>`;
    }

    let btns = '';
    if (a.status === 'suggested') {
      btns = `<button class="btn btn-primary" onclick="updateActionStatus('${a.id}','planned')">Add to plan</button>
              <button class="btn" onclick="updateActionStatus('${a.id}','dismissed')">Dismiss</button>`;
    } else if (a.status === 'planned') {
      btns = `<button class="btn btn-green" onclick="actionItem('${a.id}','${a.page_id}')">Mark actioned ✓</button>`;
    } else if (a.status === 'measuring') {
      const end = new Date(a.measurement_end_date);
      const days = Math.max(0, Math.ceil((end - new Date()) / 86400000));
      btns = `<span style="font-size:11px; color:var(--text3);">${days}d remaining</span>`;
    }

    return `<div class="action-item">
      <div class="action-status">${statusDot}</div>
      <div class="action-body">
        <div class="action-title">${a.title}</div>
        <div class="action-desc">${a.description || ''}</div>
        <div class="action-meta">
          ${statusBadge} ${priorityBadge}
          ${a.pages?.url ? `<span class="badge b-gray mono">${a.pages.url}</span>` : ''}
          ${a.expected_impact ? `<span style="font-size:11px; color:var(--text3);">${a.expected_impact}</span>` : ''}
        </div>
        ${resultHtml}
      </div>
      <div class="action-btns">${btns}</div>
    </div>`;
  }).join('');
}

function filterActions(status, el) {
  currentActionFilter = status;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  loadActions();
}

async function updateActionStatus(id, status) {
  await supabase.from('seo_actions').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  loadActions();
}

async function actionItem(actionId, pageId) {
  const today = new Date();
  const endDate = new Date(); endDate.setDate(endDate.getDate() + 28);

  // Update action status
  await supabase.from('seo_actions').update({
    status: 'measuring',
    actioned_at: today.toISOString(),
    measurement_start_date: today.toISOString().split('T')[0],
    measurement_end_date: endDate.toISOString().split('T')[0],
    updated_at: new Date().toISOString(),
  }).eq('id', actionId);

  // Trigger before-snapshot crawl
  const { data: page } = await supabase.from('pages').select('full_url').eq('id', pageId).single();
  if (page?.full_url) {
    await fetch('/api/crawl-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_id: pageId, action_id: actionId, snapshot_type: 'before', url: page.full_url }),
    });
  }

  loadActions();
}

async function generateActions() {
  // Get low-scoring pages for context
  const { data: pages } = await supabase.from('pages').select('url, title, h1, has_faq_schema, word_count').limit(10);

  const prompt = `You are an SEO expert for Baboodle (baboodle.co.uk), a UK circular economy baby equipment rental platform.

Based on these pages, generate 6 specific SEO action items. Return as JSON array only, no other text.

Pages: ${JSON.stringify(pages)}

Format: [{"title": "...", "description": "...", "action_type": "meta_title|meta_description|h1|content|schema|internal_links|new_page|technical", "priority": "high|medium|low", "expected_impact": "...", "page_url": "..."}]`;

  const btn = document.querySelector('#actions .btn-primary');
  btn.textContent = '✦ Generating...';
  btn.disabled = true;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const suggestions = JSON.parse(clean);

    for (const s of suggestions) {
      let pageId = null;
      if (s.page_url) {
        const { data: pg } = await supabase.from('pages').select('id').eq('url', s.page_url).single();
        pageId = pg?.id || null;
      }
      await supabase.from('seo_actions').insert({
        page_id: pageId,
        title: s.title,
        description: s.description,
        action_type: s.action_type,
        priority: s.priority,
        expected_impact: s.expected_impact,
        suggested_by: 'claude',
        status: 'suggested',
      });
    }
    loadActions();
  } catch (e) {
    alert('Error generating actions. Check API key.');
  } finally {
    btn.textContent = '✦ Generate new actions';
    btn.disabled = false;
  }
}

// ─── Content Plan ─────────────────────────────────────────────────────────
async function loadContent() {
  const { data: items } = await supabase.from('content_plan').select('*').order('created_at', { ascending: false });

  if (!items || items.length === 0) {
    document.getElementById('contentList').innerHTML = `<div class="empty">No content planned yet — click "Generate content ideas" to get AI suggestions based on your keyword gaps</div>`;
    return;
  }

  const statusColor = { planned:'b-gray', in_progress:'b-amber', published:'b-green' };
  document.getElementById('contentList').innerHTML = items.map(item => `
    <div class="card">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div style="flex:1;">
          <div style="font-size:15px; font-weight:500; margin-bottom:4px;">${item.title}</div>
          <div style="font-size:12px; color:var(--text2); margin-bottom:8px;">${item.content_type || 'Content'} · Target keyword: ${item.target_keyword || '—'} · ${item.keyword_volume ? item.keyword_volume.toLocaleString() + ' searches/mo' : ''}</div>
          ${item.brief ? `<div style="font-size:13px; color:var(--text2); line-height:1.6;">${item.brief.slice(0,200)}${item.brief.length>200?'...':''}</div>` : ''}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px;">
          <span class="badge ${statusColor[item.status] || 'b-gray'}">${item.status?.replace('_',' ')}</span>
          ${item.status === 'planned' ? `<button class="btn" onclick="updateContentStatus('${item.id}','in_progress')">Start writing</button>` : ''}
          ${item.status === 'in_progress' ? `<button class="btn btn-green" onclick="updateContentStatus('${item.id}','published')">Mark published</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

async function updateContentStatus(id, status) {
  await supabase.from('content_plan').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  loadContent();
}

async function generateContentIdeas() {
  const btn = document.querySelector('#content .btn-primary');
  btn.textContent = '✦ Generating...';
  btn.disabled = true;

  const prompt = `Generate 5 high-value content pieces for Baboodle (baboodle.co.uk), a UK circular economy baby equipment rental platform targeting London parents.

Return JSON array only: [{"title":"...","content_type":"blog|landing_page|guide","target_keyword":"...","keyword_volume":number,"keyword_cluster":"...","brief":"2-3 sentence brief covering angle, structure, and SEO goal"}]

Focus on: pram hire London, circular economy parenting, baby gear rental vs buying, travel with baby UK, eco baby products.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const ideas = JSON.parse(clean);
    for (const i of ideas) {
      await supabase.from('content_plan').insert({ ...i, suggested_by: 'claude', status: 'planned' });
    }
    loadContent();
  } catch (e) {
    alert('Error generating ideas.');
  } finally {
    btn.textContent = '✦ Generate content ideas';
    btn.disabled = false;
  }
}

// ─── AEO ──────────────────────────────────────────────────────────────────
async function loadAEO() {
  const { data: queries } = await supabase.from('aeo_queries').select('*').order('created_at', { ascending: false });

  const aeoAI = document.getElementById('aeoAI');
  aeoAI.innerHTML = `Baboodle's AI search visibility is currently low. Key gaps: no FAQ schema on product pages means AI models don't cite Baboodle when answering "can I rent a pram in London?" or "is baby equipment rental worth it?" — queries with thousands of monthly searches. Priority: add FAQPage structured data to top 5 pages, create definitional "how it works" content, and add Organisation schema to homepage.`;

  if (!queries || queries.length === 0) {
    document.getElementById('aeoList').innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">Target queries — add queries you want Baboodle to appear in</div></div>
        <div class="empty">No AEO queries tracked yet</div>
        <button class="btn btn-primary" style="margin-top:12px;" onclick="seedAEOQueries()">✦ Generate target queries</button>
      </div>`;
    return;
  }

  document.getElementById('aeoList').innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">AI search queries to target</div>
        <button class="btn" onclick="seedAEOQueries()">+ Add queries</button>
      </div>
      ${queries.map(q => `
        <div style="padding: 12px 0; border-bottom: 0.5px solid var(--border);">
          <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div style="flex:1;">
              <div style="font-size:13px; font-weight:500; margin-bottom:3px;">"${q.query}"</div>
              <div style="font-size:12px; color:var(--text3); margin-bottom:6px;">${q.competitor_cited ? 'Currently citing: ' + q.competitor_cited : 'Not yet checked'}</div>
              ${q.actions_needed ? `<div style="display:flex; gap:6px; flex-wrap:wrap;">${q.actions_needed.map(a => `<span class="badge b-gray">${a}</span>`).join('')}</div>` : ''}
            </div>
            <span class="badge ${q.appearing ? 'b-green' : 'b-red'}">${q.appearing ? 'Appearing' : 'Not appearing'}</span>
          </div>
        </div>
      `).join('')}
    </div>`;
}

async function seedAEOQueries() {
  const defaultQueries = [
    { query: 'can you rent a pram in London?', appearing: false, actions_needed: ['Add FAQ schema', 'Create direct answer content'] },
    { query: 'is renting baby equipment worth it?', appearing: false, actions_needed: ['Blog post needed', 'Clear value prop page'] },
    { query: 'eco-friendly baby equipment UK', appearing: false, actions_needed: ['Sustainability page SEO', 'Add schema'] },
    { query: 'how does baby equipment rental work?', appearing: false, actions_needed: ['How it works page', 'FAQ schema'] },
    { query: 'best place to rent a bugaboo UK', appearing: false, actions_needed: ['Bugaboo page optimisation', 'Brand schema'] },
  ];
  for (const q of defaultQueries) {
    await supabase.from('aeo_queries').upsert(q, { onConflict: 'query' });
  }
  loadAEO();
}

// ─── AI Overview Analysis ─────────────────────────────────────────────────
async function runAIAnalysis(section, context) {
  const prompt = `You are an SEO analyst for Baboodle (baboodle.co.uk), a circular economy baby equipment rental platform in the UK.

Analyse this data and give 3 specific, prioritised observations. Be direct and actionable — no generic advice.

Data: ${JSON.stringify(context)}

Format as 3 short paragraphs. Start each with the insight, not with "I noticed" or "It seems".`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    document.getElementById('overviewAI').innerHTML = text.replace(/\n\n/g, '<br><br>');
  } catch (e) {
    document.getElementById('overviewAI').innerHTML = 'AI analysis unavailable.';
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────
async function triggerSync() {
  const btn = document.querySelector('.sidebar .btn');
  btn.textContent = 'Syncing...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/gsc-sync', { method: 'POST' });
    const data = await res.json();
    document.getElementById('syncStatus').textContent = 'Synced just now';
    loadOverview(); loadPages();
  } catch (e) {
    document.getElementById('syncStatus').textContent = 'Sync failed';
  } finally {
    btn.textContent = 'Sync now';
    btn.disabled = false;
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────
function showSection(id, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  el?.classList.add('active');
}
