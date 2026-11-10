/* Baboodle search brain – dashboard front end */
(function () {
  const KEY = 'bb_dash_key';
  let pass = sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || '';
  let current = 'overview';
  let chart = null;
  const cache = {};

  const TABS = [
    ['overview', 'Overview'], ['keywords', 'Keywords'], ['onpage', 'On-page content'], ['meta', 'Meta titles'],
    ['technical', 'Technical'], ['images', 'Images and alt text'], ['blogs', 'Blogs'], ['aeo', 'AI mentions'], ['results', 'Results'], ['strategy', 'Strategy'],
  ];

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n0 = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-GB'));
  const pct = (v, d = 1) => (v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%');
  const pos = (v) => (v == null || isNaN(v) || v === 0 ? '—' : Number(v).toFixed(1));
  const day = (d) => new Date(d + (String(d).length === 10 ? 'T12:00:00Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const ago = (d) => { if (!d) return 'never'; const m = (Date.now() - new Date(d)) / 6e4; return m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
  const label = { cited: 'Cited with link', mentioned: 'Named, no link', source_only: 'Used as a source', missing: 'Not mentioned', error: 'Check failed', positive: 'Positive', negative: 'Negative', neutral: 'No real change', too_early: 'Too early', idea: 'Idea', drafting: 'Writing…', draft_ready: 'Draft ready', in_shopify: 'In Shopify (unpublished)', published: 'Published', win: 'Win', loss: 'Worse', flat: 'Flat', suggested: 'New', approved: 'Approved', done: 'Done', dismissed: 'Dismissed' };
  const SPARK = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 1.8l1.6 6.4 5.6-3.5-3.5 5.6 6.5 1.7-6.5 1.7 3.5 5.6-5.6-3.5L12 22.2l-1.6-6.4-5.6 3.5 3.5-5.6L1.8 12l6.5-1.7-3.5-5.6 5.6 3.5z"/></svg>';
  const ask = (ctx) => `<button class="ask" type="button" data-ask="${esc(ctx)}" title="Ask Claude what to do about this" aria-label="Ask Claude what to do about this">${SPARK}</button>`;
  const pill = (cls, text) => `<span class="pill p-${esc(cls)}">${esc(text || label[cls] || cls)}</span>`;

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }

  async function api(action, params = {}, method = 'GET', body) {
    const qs = new URLSearchParams({ action, ...params }).toString();
    const res = await fetch('/api/api?' + qs, { method, headers: { 'x-dash-key': pass, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { showGate(true); throw new Error('Wrong password'); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  const post = (action, body) => api(action, {}, 'POST', body);

  function delta(now, prev, invert = false, fmt = 'pct') {
    if (prev == null || now == null || isNaN(prev) || isNaN(now)) return '<span class="delta flat">no comparison yet</span>';
    if (fmt === 'pos') {
      const d = prev - now; // lower position is better
      if (Math.abs(d) < 0.05) return '<span class="delta flat">no change</span>';
      return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} places</span>`;
    }
    if (!prev) return '<span class="delta flat">new</span>';
    const ch = (now - prev) / prev;
    const good = invert ? ch < 0 : ch > 0;
    if (Math.abs(ch) < 0.005) return '<span class="delta flat">no change</span>';
    return `<span class="delta ${good ? 'up' : 'down'}">${ch > 0 ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(0)}% vs previous 7 days</span>`;
  }

  // ---------- gate ----------
  function showGate(bad) { $('#app').hidden = true; $('#gate').hidden = false; $('#gate-err').hidden = !bad; $('#gate-pass').focus(); }
  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    pass = $('#gate-pass').value.trim();
    try { await api('overview'); localStorage.setItem(KEY, pass); start(); } catch (err) { $('#gate-err').hidden = false; }
  });

  // ---------- shell ----------
  function renderTabs(todo = {}) {
    const counts = { onpage: todo.onpage, meta: todo.meta, technical: todo.technical, images: todo.images, keywords: todo.keywords, aeo: todo.aeo };
    $('#tabs').innerHTML = TABS.map(([id, name]) => `<button class="tab ${id === current ? 'on' : ''}" data-tab="${id}">${esc(name)}${counts[id] ? `<span class="count">${counts[id]}</span>` : ''}</button>`).join('');
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });

  function renderStatus(o) {
    const r = o.runs || {};
    const sync = r['gsc-sync'], scan = r['site-scan'], an = r['analyze'];
    const bit = (name, run) => `<span title="${esc(run ? run.message : '')}">${name}: ${run ? (run.status === 'error' ? '<b class="down">failed</b>' : run.status === 'running' ? 'running…' : ago(run.finished_at)) : 'not run yet'}</span>`;
    const weeklyBusy = ['site-scan', 'aeo-check', 'analyze'].some((j) => r[j] && r[j].status === 'running' && Date.now() - new Date(r[j].started_at) < 25 * 60000);
    $('#status').innerHTML = `${bit('Search Console', sync)} · ${bit('Site scan', scan)} · ${bit('AI check', r['aeo-check'])} · ${bit('Analysis', an)}
      ${weeklyBusy ? '<span class="pill p-drafting">Weekly check running…</span>' : '<button class="btn btn--sm" data-run="weekly" title="Scan the site, check AI answers and write new suggestions (takes about 10 minutes)">Run weekly check now</button>'}`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    b.disabled = true;
    try { await post('run', { job: b.dataset.run }); toast('Started. It takes about 10 minutes and runs in the background.'); b.outerHTML = '<span class="pill p-drafting">Weekly check running…</span>'; } catch (err) { toast(err.message); }
    setTimeout(() => (b.disabled = false), 4000);
  });

  async function go(tab) {
    current = tab;
    location.hash = tab;
    renderTabs(cache.todo);
    const v = $('#view');
    v.innerHTML = '<div class="empty">Loading…</div>';
    try { await VIEWS[tab](v); } catch (err) { v.innerHTML = `<div class="empty"><h3>Couldn't load this</h3><p>${esc(err.message)}</p></div>`; }
    v.focus({ preventScroll: true });
  }

  // ---------- suggestion cards (shared by tabs) ----------
  const canApply = (s) => ['images', 'meta'].includes(s.category) && !s.applied_at;
  function proposedHTML(s) {
    const p = s.proposed || {};
    const parts = [];
    const ed = (f) => canApply(s) ? ` contenteditable="true" data-field="${f}" title="Click to edit before applying"` : '';
    if (p.current_title || p.title) parts.push(`${p.current_title ? `<div class="was">${esc(p.current_title)}</div>` : ''}${p.title ? `<div class="now"${ed('title')}>${esc(p.title)}</div>` : ''}`);
    if (p.current_description || p.description) parts.push(`${p.current_description ? `<div class="was">${esc(p.current_description)}</div>` : ''}${p.description ? `<div class="now"${ed('description')}>${esc(p.description)}</div>` : ''}`);
    if (p.alt) parts.push(`<div class="now"${ed('alt')}>${esc(p.alt)}</div><div class="url">${esc(p.src)}</div>`);
    if (p.copy) parts.push(esc(p.copy));
    const rest = Object.entries(p).filter(([k]) => !['current_title', 'title', 'current_description', 'description', 'alt', 'src', 'copy'].includes(k));
    rest.forEach(([k, v]) => parts.push(`<b>${esc(k.replace(/_/g, ' '))}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}`));
    return parts.length ? `<div class="proposed">${parts.join('<br>')}</div>` : '';
  }
  function copyText(s) { const p = s.proposed || {}; return [p.title, p.description, p.alt, p.copy].filter(Boolean).join('\n\n'); }

  function fit(score, note) {
    if (score == null && !note) return '';
    const lbl = score == null ? 'Strategy' : score >= 4 ? 'Strategy fit' : score === 0 ? 'Off strategy' : 'Some fit';
    const cls = score == null ? 'p-low' : score >= 4 ? 'p-done' : score === 0 ? 'p-high' : 'p-low';
    return `<span class="pill ${cls}" title="${esc(note || '')}">${lbl}${score != null ? ' ' + score + '/5' : ''}</span>${note ? ` <span class="soft small">${esc(note)}</span>` : ''}`;
  }

  function suggestionList(rows, emptyMsg) {
    if (!rows.length) return `<div class="empty"><h3>Nothing waiting here</h3><p>${esc(emptyMsg)}</p></div>`;
    return `<div class="list">${rows.map((s) => `
      <div class="item" data-sid="${s.id}">
        <div>${pill(s.priority)}</div>
        <div class="item__main">
          <div class="item__title">${esc(s.title)}${s.effort_minutes ? ` <span class="tiny soft">· ~${esc(s.effort_minutes)} min</span>` : ''}</div>
          <div class="item__meta">${s.page_url ? `<a href="https://baboodle.co.uk${esc(s.page_url)}" target="_blank" rel="noopener">${esc(s.page_url)}</a> · ` : ''}${esc(s.detail || '')}</div>${s.strategy_score != null ? `<div style="margin-top:4px">${fit(s.strategy_score, s.strategy_note)}</div>` : ''}
          ${proposedHTML(s)}
          ${s.apply_error && !s.applied_at ? `<div class="tiny" style="color:var(--red);margin-top:4px">Couldn't apply: ${esc(s.apply_error)}</div>` : ''}
        </div>
        <div class="item__actions">
          ${s.status !== 'suggested' ? pill(s.status) : ''}
          ${ask(`Suggestion (${s.category}, ${s.priority} priority${s.page_url ? ', page ' + s.page_url : ''}): "${s.title}". ${s.detail || ''} ${s.proposed && Object.keys(s.proposed).length ? 'Proposed: ' + JSON.stringify(s.proposed) : ''} Talk me through exactly how to do this.`)}
          ${canApply(s) ? '<button class="btn btn--sm btn--coral" data-act="apply" title="Changes it live on baboodle.co.uk now. You can undo it.">Apply to Shopify</button>' : ''}
          ${copyText(s) ? '<button class="btn btn--sm" data-act="copy">Copy</button>' : ''}
          ${s.status === 'suggested' && !canApply(s) ? '<button class="btn btn--sm" data-act="approved">Approve</button>' : ''}
          <button class="btn btn--sm ${canApply(s) ? '' : 'btn--coral'}" data-act="done" title="${canApply(s) ? 'Use this if you changed it in Shopify yourself' : 'Logs it as a change so its impact is measured'}">Mark done</button>
          <button class="btn btn--sm btn--ghost" data-act="dismissed">Dismiss</button>
        </div>
      </div>`).join('')}</div>`;
  }
  async function wireSuggestions(root, rows, reload) {
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      const it = e.target.closest('[data-sid]');
      if (!b || !it) return;
      const s = rows.find((r) => r.id === it.dataset.sid);
      if (b.dataset.act === 'copy') { await navigator.clipboard.writeText(copyText(s)); toast('Copied'); return; }
      b.disabled = true;
      if (b.dataset.act === 'apply' || b.dataset.act === 'undo') {
        const edits = {};
        it.querySelectorAll('[data-field]').forEach((el) => { const t = el.innerText.trim(); if (t && t !== (s.proposed || {})[el.dataset.field]) edits[el.dataset.field] = t; });
        b.textContent = b.dataset.act === 'apply' ? 'Applying…' : 'Undoing…';
        try {
          await post(b.dataset.act === 'apply' ? 'apply' : 'undo-apply', { id: s.id, proposed: Object.keys(edits).length ? edits : undefined });
          toast(b.dataset.act === 'apply' ? 'Live on baboodle.co.uk. Undo it under "Applied in Shopify".' : 'Undone. Shopify is back to how it was.');
          reload();
        } catch (err) { toast(err.message); b.disabled = false; b.textContent = b.dataset.act === 'apply' ? 'Apply to Shopify' : 'Undo'; }
        return;
      }
      try {
        await post('suggestion', { id: s.id, status: b.dataset.act });
        toast(b.dataset.act === 'done' ? 'Marked done and logged as a change' : b.dataset.act === 'approved' ? 'Approved' : 'Dismissed');
        reload();
      } catch (err) { toast(err.message); b.disabled = false; }
    });
  }

  // ---------- views ----------
  const VIEWS = {};

  VIEWS.overview = async (v) => {
    const o = await api('overview');
    cache.todo = o.todo; renderTabs(o.todo); renderStatus(o);
    if (!o.connected || !o.last_date) {
      v.innerHTML = `${!o.connected ? `<div class="notice notice--coral"><span><b>Connect Google Search Console</b> to start. Sign in with the Google account that can see baboodle.co.uk in Search Console.</span><a class="btn btn--coral" href="/api/gsc-auth?key=${encodeURIComponent(pass)}">Connect Search Console</a></div>` : '<div class="notice">Search Console is connected. The first 90 days are loading in the background, which takes a few minutes. Refresh shortly.</div>'}
      <div class="empty"><h3>No search data yet</h3><p>Once Search Console is connected the overview fills in automatically every morning.</p></div>`;
      return;
    }
    const w = o.week, a = o.aeo || {};
    const todoTotal = Object.values(o.todo || {}).reduce((x, y) => x + y, 0);
    v.innerHTML = `
      <div class="head"><div><h1>How we're doing this week</h1><p class="soft">${day(w.from)} – ${day(w.to)} vs ${day(w.prev_from)} – ${day(w.prev_to)} · Google data lags by about 2 days</p></div></div>
      ${Object.values(o.runs || {}).some((r) => /credit balance/i.test(r.message || '')) ? '<div class="notice notice--coral"><span><b>Your Claude API credit has run out.</b> The chat, the AI-mentions check and the weekly analysis are paused until it\'s topped up at console.anthropic.com → Plans &amp; Billing.</span></div>' : ''}
      ${(o.alerts || []).map((al) => `<div class="notice ${al.severity === 'urgent' ? 'notice--coral' : ''}"><span><b>${esc(al.title)}</b>${al.detail ? ' · ' + esc(al.detail) : ''}</span><span style="display:flex;gap:6px;align-items:center">${ask(`Alert: ${al.title}. ${al.detail || ''}`)}<button class="btn btn--sm" data-alert="${al.id}">Got it</button></span></div>`).join('')}
      ${planHTML(o.plan)}
      <div class="grid g4">
        <div class="card kpi">${ask(`Whole-site Google clicks: ${w.now.clicks} in ${w.from} to ${w.to} vs ${w.prev.clicks} the 7 days before.`)}<div class="label">Clicks from Google</div><div class="num">${n0(w.now.clicks)}</div>${delta(w.now.clicks, w.prev.clicks)}</div>
        <div class="card kpi">${ask(`Whole-site Google impressions: ${w.now.impressions} in ${w.from} to ${w.to} vs ${w.prev.impressions} the 7 days before.`)}<div class="label">Times shown in Google</div><div class="num">${n0(w.now.impressions)}</div>${delta(w.now.impressions, w.prev.impressions)}</div>
        <div class="card kpi">${ask(`Whole-site click rate: ${pct(w.now.ctr)} in ${w.from} to ${w.to} vs ${pct(w.prev.ctr)} the 7 days before.`)}<div class="label">Click rate</div><div class="num">${pct(w.now.ctr)}</div>${delta(w.now.ctr, w.prev.ctr)}</div>
        <div class="card kpi">${ask(`Whole-site average Google position: ${pos(w.now.position)} in ${w.from} to ${w.to} vs ${pos(w.prev.position)} the 7 days before.`)}<div class="label">Average position</div><div class="num">${pos(w.now.position)}</div>${delta(w.now.position, w.prev.position, false, 'pos')}</div>
      </div>

      <div class="section card"><div class="head" style="margin-bottom:6px"><h3>Clicks from Google, last 8 weeks</h3><div class="seg" id="metric"><button class="on" data-m="clicks">Clicks</button><button data-m="impressions">Shown</button><button data-m="position">Position</button></div></div>
        <div class="chartbox"><canvas id="chart" role="img" aria-label="Daily Google clicks for the last 8 weeks, with markers for changes made"></canvas></div>
        <p class="tiny soft" style="margin:6px 0 0">Coral lines mark changes you made. Dotted line is the 7-day average.</p></div>

      <div class="section grid g2">
        <div class="card"><div class="head" style="margin-bottom:4px"><h3>Your changes and what they did</h3><button class="btn btn--sm" id="add-change">Log a change</button></div>
          <p class="tiny soft" style="margin:0 0 6px">Clicks a day on that page, 7 days before vs up to 7 days after</p>
          <form id="change-form" class="editor" hidden><label>What changed</label><input name="description" required placeholder="New FAQ section on the cot hire page"><label>Page (optional)</label><input name="page_url" placeholder="/collections/cots"><label>Date</label><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"><p><button class="btn btn--coral btn--sm" type="submit">Save</button></p></form>
          <div class="list">${(o.changes || []).map((c) => {
            const b = c.before || {}, a2 = c.after || {};
            const perB = b.days ? b.clicks / b.days : null, perA = a2.days ? a2.clicks / a2.days : null;
            return `<div class="change"><div><div class="item__title">${esc(c.description)}</div><div class="item__meta">${day(c.date)}${c.page_url ? ' · ' + esc(c.page_url) : ''}</div>
              <div class="ba"><span>Before <b>${perB == null ? '—' : perB.toFixed(1)}</b>/day · pos ${pos(b.position)}</span><span>After <b>${perA == null ? '—' : perA.toFixed(1)}</b>/day · pos ${pos(a2.position)}</span></div></div>
              <div style="display:flex;gap:6px;align-items:flex-start">${pill(c.verdict, c.verdict === 'too_early' ? `Too early (${c.days_after} days)` : null)}${ask(`Change made on ${c.date}${c.page_url ? ' to ' + c.page_url : ''}: "${c.description}". Clicks/day before ${perB == null ? 'n/a' : perB.toFixed(1)}, after ${perA == null ? 'n/a' : perA.toFixed(1)}; position before ${pos(b.position)}, after ${pos(a2.position)}. Verdict so far: ${c.verdict}.`)}</div></div>`;
          }).join('') || '<p class="soft">No changes logged yet.</p>'}</div></div>

        <div class="grid" style="align-content:start">
          <div class="card"><h3>Biggest ranking moves</h3>
            <div class="tablewrap"><table><thead><tr><th>Search</th><th class="num">Was</th><th class="num">Now</th><th class="num">Shown</th><th></th></tr></thead><tbody>
            ${(o.gainers || []).map((m) => `<tr><td>${esc(m.query)}<div class="url">${esc(m.page)}</div></td><td class="num">${pos(m.pos_prev)}</td><td class="num up"><b>${pos(m.pos_now)}</b></td><td class="num">${n0(m.impr_now)}</td><td>${ask(`Search "${m.query}" (page ${m.page}) moved up from position ${pos(m.pos_prev)} to ${pos(m.pos_now)} this week, shown ${m.impr_now} times.`)}</td></tr>`).join('')}
            ${(o.losers || []).map((m) => `<tr><td>${esc(m.query)}<div class="url">${esc(m.page)}</div></td><td class="num">${pos(m.pos_prev)}</td><td class="num down"><b>${pos(m.pos_now)}</b></td><td class="num">${n0(m.impr_now)}</td><td>${ask(`Search "${m.query}" (page ${m.page}) dropped from position ${pos(m.pos_prev)} to ${pos(m.pos_now)} this week, shown ${m.impr_now} times.`)}</td></tr>`).join('') || ''}
            </tbody></table></div>${!(o.gainers || []).length && !(o.losers || []).length ? '<p class="soft small">Needs two full weeks of data.</p>' : ''}</div>
          <div class="card card--lav">${ask(`AI mentions: Claude names Baboodle in ${a.mentioned} of ${a.checked} parent questions and links in ${a.cited}. Named instead: ${(a.competitors || []).map((c) => c[0]).join(', ')}.`)}<h3>AI mentions</h3><p style="margin:0">${a.checked ? `Claude names Baboodle in <b>${a.mentioned} of ${a.checked}</b> parent questions and links to you in <b>${a.cited}</b>.` : 'The first AI check runs with the weekly check.'}</p>
            ${a.competitors && a.competitors.length ? `<p class="small" style="margin:8px 0 0">Named instead: ${a.competitors.map(([c, k]) => `${esc(c)} (${k})`).join(', ')}</p>` : ''}
            <p style="margin:10px 0 0"><button class="btn btn--sm" data-go="aeo">See all questions</button></p></div>
          <div class="card"><h3>Waiting for you</h3><p style="margin:0 0 8px">${todoTotal} suggestion${todoTotal === 1 ? '' : 's'} · ${o.drafts_ready} blog draft${o.drafts_ready === 1 ? '' : 's'} ready</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${TABS.filter(([id]) => o.todo && o.todo[id]).map(([id, name]) => `<button class="btn btn--sm" data-go="${id}">${esc(name)} (${o.todo[id]})</button>`).join('')}${o.drafts_ready ? '<button class="btn btn--sm btn--coral" data-go="blogs">Review drafts</button>' : ''}</div></div>
        </div>
      </div>

      <div class="section card"><h3>Top pages this week</h3><div class="tablewrap"><table><thead><tr><th>Page</th><th class="num">Clicks</th><th class="num">Last week</th><th class="num">Position</th><th class="num">Last week</th><th></th></tr></thead><tbody>
        ${(o.pages || []).map((p) => `<tr><td><a href="https://baboodle.co.uk${esc(p.page)}" target="_blank" rel="noopener">${esc(p.page)}</a></td><td class="num">${n0(p.clicks)}</td><td class="num ${p.clicks > p.prev_clicks ? 'up' : p.clicks < p.prev_clicks ? 'down' : ''}">${n0(p.prev_clicks)}</td><td class="num">${pos(p.pos)}</td><td class="num">${pos(p.prev_pos)}</td><td>${ask(`Page ${p.page}: ${p.clicks} Google clicks this week vs ${p.prev_clicks} last week; position ${pos(p.pos)} vs ${pos(p.prev_pos)}; shown ${p.impressions} times.`)}</td></tr>`).join('')}
      </tbody></table></div></div>`;

    drawChart(o, 'clicks');
    v.querySelectorAll('[data-alert]').forEach((x) => (x.onclick = async () => { await post('resolve-alert', { id: x.dataset.alert }); x.closest('.notice').remove(); }));
    const rp = v.querySelector('#replan');
    if (rp) rp.onclick = async () => { rp.disabled = true; rp.textContent = 'Rebuilding…'; try { await post('run', { job: 'plan' }); toast('Rebuilding the plan around your strategy. Refresh in a minute or two.'); } catch (e) { toast(e.message); rp.disabled = false; rp.textContent = 'Rebuild plan'; } };
    v.querySelectorAll('[data-plan-done]').forEach((x) => (x.onclick = async () => { x.disabled = true; await post('suggestion', { id: x.dataset.planDone, status: 'done' }); toast('Done and logged as a change'); go('overview'); }));
    $('#metric').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (!b) return; [...$('#metric').children].forEach((x) => x.classList.toggle('on', x === b)); drawChart(o, b.dataset.m); });
    $('#add-change').onclick = () => { $('#change-form').hidden = !$('#change-form').hidden; };
    $('#change-form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); await post('change', Object.fromEntries(f)); toast('Change logged'); go('overview'); };
  };

  function planHTML(plan) {
    if (!plan || !(plan.items || []).length) return '<div class="card card--lav" style="margin-bottom:14px"><h3>This week\'s 3-hour plan</h3><p style="margin:0">Your first plan arrives after the first weekly check (every Monday morning).</p></div>';
    const total = plan.items.reduce((a, i) => a + (i.minutes || 0), 0);
    const doneMin = plan.items.filter((i) => i.status === 'done').reduce((a, i) => a + (i.minutes || 0), 0);
    const goTab = { blog: 'blogs', alt_text: 'images', alert: 'overview' };
    return `<div class="card" style="margin-bottom:14px;border:2px solid var(--coral2)">
      <div class="head" style="margin-bottom:6px"><div><h3>This week's 3-hour plan</h3><p class="soft small" style="margin:4px 0 0">Week of ${day(plan.week_of)} · ${total} minutes planned · ${doneMin} done · built around your Strategy tab</p></div><button class="btn btn--sm" id="replan" title="Rebuild this week's plan from your current strategy (about a minute, costs a few pence)">Rebuild plan</button></div>
      ${plan.summary ? `<p style="margin:0 0 6px">${esc(plan.summary)}</p>` : ''}
      <div class="list">${plan.items.map((i, k) => `<div class="item"><div class="pill ${i.status === 'done' ? 'p-done' : 'p-low'}">${i.status === 'done' ? '✓ ' : ''}${esc(i.minutes)} min</div>
        <div class="item__main"><div class="item__title">${k + 1}. ${esc(i.title)}</div><div class="item__meta">${esc(i.why || '')}</div>${i.strategy_fit ? `<div style="margin-top:4px"><span class="pill p-done">${esc(i.strategy_fit)}</span></div>` : ''}
        ${(i.steps || []).length ? `<ol class="small" style="margin:6px 0 0;padding-left:18px">${i.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div>
        <div class="item__actions">${ask(`This week's plan item: "${i.title}" (${i.minutes} min). ${i.why || ''} Steps: ${(i.steps || []).join(' / ')}. Walk me through doing this now.`)}${i.type === 'suggestion' && i.ref_id && i.status !== 'done' ? `<button class="btn btn--sm btn--coral" data-plan-done="${esc(i.ref_id)}">Mark done</button>` : ''}${goTab[i.type] && goTab[i.type] !== 'overview' ? `<button class="btn btn--sm" data-go="${goTab[i.type]}">Open</button>` : ''}</div></div>`).join('')}</div></div>`;
  }

  function drawChart(o, metric) {
    const s = (o.series || []).slice(-56);
    const vals = s.map((r) => (metric === 'position' ? Number(r.position) : r[metric]));
    const avg = vals.map((_, i) => { const w = vals.slice(Math.max(0, i - 6), i + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
    const dates = s.map((r) => r.date);
    const changeIdx = (o.changes || []).map((c) => dates.indexOf(c.date)).filter((i) => i >= 0);
    if (chart) chart.destroy();
    const markers = { id: 'markers', afterDatasetsDraw(ch) { const { ctx, chartArea: a, scales: { x } } = ch; ctx.save(); ctx.strokeStyle = '#FC7076'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); [...new Set(changeIdx)].forEach((i) => { const px = x.getPixelForValue(i); ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); }); ctx.restore(); } };
    chart = new Chart($('#chart'), {
      type: 'line',
      data: { labels: dates.map(day), datasets: [
        { data: vals, borderColor: '#2A2522', backgroundColor: 'rgba(252,112,118,.12)', fill: metric !== 'position', borderWidth: 2, pointRadius: 0, tension: 0 },
        { data: avg, borderColor: '#D93A42', borderDash: [3, 3], borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0 },
      ] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.datasetIndex ? '7-day avg ' : '') + (metric === 'position' ? Number(c.raw).toFixed(1) : Math.round(c.raw).toLocaleString('en-GB')) } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: '#6B6560' } }, y: { reverse: metric === 'position', grid: { color: '#efe8dd' }, ticks: { color: '#6B6560' } } } },
      plugins: [markers],
    });
  }

  VIEWS.keywords = async (v) => {
    const [k, sug] = await Promise.all([api('keywords'), api('suggestions', { category: 'keywords', status: 'suggested,approved' })]);
    let filter = 'opps', q = '', sortKey = 'impressions', dir = -1;
    v.innerHTML = `<div class="head"><div><h1>Keywords</h1><p class="soft">Each row is a search people typed into Google, with the page of yours Google showed for it (one page often appears for many searches). Last 28 days${k.to ? ', to ' + day(k.to) : ''}. Hover a label for what it means. ${k.volumes_connected ? (k.volumes_count ? 'Monthly searches are real UK Google volumes from Keyword Planner.' : 'Keyword Planner is connected: monthly searches arrive with the next weekly check.') : 'Monthly searches (Keyword Planner) appear once DataForSEO is connected in Netlify.'}</p></div></div>
      <div class="card" id="ksug"><h3>Keyword suggestions</h3>${suggestionList(sug.rows, 'New keyword ideas arrive with the weekly check.')}</div>
      ${(k.gaps || []).length ? `<div class="section card"><div class="head" style="margin-bottom:8px"><div><h3>Searches you're missing</h3><p class="soft small" style="margin:4px 0 0">Real monthly UK searches where Baboodle isn't on page 1 of Google, or doesn't appear at all. Found from your strategy priorities and the searches you already show for.</p></div><input id="gq" placeholder="Filter, e.g. double" aria-label="Filter missing searches"></div>
        <div class="tablewrap" style="max-height:420px"><table><thead><tr><th>Search</th><th class="num">Monthly searches</th><th>Last 12 months</th><th class="num">You now</th><th>Your page</th><th class="num" title="What advertisers pay per click: a sign of how commercially valuable the search is">Ad CPC</th><th></th></tr></thead><tbody id="gt"></tbody></table></div></div>` : ''}
      <div class="section card"><div class="filters"><div class="seg" id="kf"><button data-f="opps" class="on">Opportunities</button><button data-f="ctr">Seen, not clicked</button><button data-f="top3">Top 3</button><button data-f="all">All</button></div><input id="kq" placeholder="Filter searches, e.g. travel" aria-label="Filter searches"></div>
        <div class="tablewrap"><table><thead><tr><th class="sort" data-s="query">Search</th><th>Page Google shows</th><th class="num sort" data-s="impressions">Shown</th><th class="num sort" data-s="clicks">Clicks</th><th class="num sort" data-s="ctr">Click rate</th><th class="num sort" data-s="pos">Position</th><th class="num sort" data-s="volume">Monthly searches</th><th></th><th></th></tr></thead><tbody id="kt"></tbody></table></div></div>`;
    const draw = () => {
      let rows = k.rows.filter((r) => !q || r.query.includes(q));
      if (filter === 'opps') rows = rows.filter((r) => r.pos >= 4 && r.pos <= 20 && r.impressions >= 30);
      if (filter === 'ctr') rows = rows.filter((r) => r.pos <= 6 && r.impressions >= 40 && r.ctr < 0.05);
      if (filter === 'top3') rows = rows.filter((r) => r.pos <= 3);
      rows.sort((a, b) => ((a[sortKey] ?? -1) > (b[sortKey] ?? -1) ? 1 : -1) * dir);
      $('#kt').innerHTML = rows.slice(0, 250).map((r) => `<tr><td>${esc(r.query)}</td><td class="url">${esc(r.page)}</td><td class="num">${n0(r.impressions)}</td><td class="num">${n0(r.clicks)}</td><td class="num">${pct(r.ctr)}</td><td class="num">${pos(r.pos)}</td><td class="num ${r.volume != null ? '' : 'soft'}">${r.volume != null ? n0(r.volume) : '—'}</td><td>${r.pos >= 4 && r.pos <= 10 && r.impressions >= 30 ? `<span title="You're on page 1 but below the top 3. Small content or link improvements can move it up.">${pill('medium', 'Close to top 3')}</span>` : r.pos > 10 && r.impressions >= 30 ? `<span title="Shown on page 2 of Google, where almost nobody clicks.">${pill('high', 'On page 2')}</span>` : r.ctr < 0.05 && r.pos <= 6 && r.impressions >= 40 ? `<span title="Near the top but rarely clicked. Either the Google title/description doesn't match what people want, or Google is showing you in an AI Overview, image box or panel rather than as a normal link.">${pill('medium', 'Seen, not clicked')}</span>` : ''}</td><td>${ask(`Search "${r.query}": ${r.volume != null ? r.volume + ' UK searches a month (Keyword Planner), ' : ''}shown ${r.impressions} times in the last 28 days, ${r.clicks} clicks (${pct(r.ctr)}), average position ${pos(r.pos)}, page Google shows: ${r.page}.`)}</td></tr>`).join('') || '<tr><td colspan="9" class="soft">Nothing matches.</td></tr>';
    };
    draw();
    const spark = (m) => { const v = (m || []).slice().reverse().map((x) => x.v || 0); if (!v.length) return ''; const mx = Math.max(...v, 1); return `<span class="spark" title="${v.join(', ')}">${v.map((x) => `<i style="height:${Math.max(2, Math.round((x / mx) * 16))}px"></i>`).join('')}</span>`; };
    let gq = '';
    const drawGaps = () => { if (!$('#gt')) return; const rows = (k.gaps || []).filter((g) => !gq || g.keyword.includes(gq)); $('#gt').innerHTML = rows.slice(0, 200).map((g) => `<tr><td>${esc(g.keyword)}</td><td class="num"><b>${n0(g.volume)}</b></td><td>${spark(g.monthly)}</td><td class="num">${g.pos ? pos(g.pos) : '<span class="soft">not shown</span>'}</td><td class="url">${esc(g.page || '—')}</td><td class="num">${g.cpc != null ? '£' + Number(g.cpc).toFixed(2) : '—'}</td><td>${ask(`Search "${g.keyword}" gets ${g.volume} UK searches a month (Keyword Planner)${g.cpc != null ? ', ads pay about £' + Number(g.cpc).toFixed(2) + ' a click' : ''}. Baboodle ${g.pos ? 'is at position ' + pos(g.pos) + ' with ' + g.page : "doesn't show for it at all"}. Is it worth going after for our strategy, and if so which page should win it and what exactly should I do?`)}</td></tr>`).join('') || '<tr><td colspan="7" class="soft">Nothing matches.</td></tr>'; };
    drawGaps();
    if ($('#gq')) $('#gq').oninput = (e) => { gq = e.target.value.toLowerCase(); drawGaps(); };
    $('#kf').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; [...$('#kf').children].forEach((x) => x.classList.toggle('on', x === b)); draw(); };
    $('#kq').oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
    v.querySelectorAll('th.sort').forEach((th) => (th.onclick = () => { dir = sortKey === th.dataset.s ? -dir : -1; sortKey = th.dataset.s; draw(); }));
    wireSuggestions($('#ksug'), sug.rows, () => go('keywords'));
  };

  async function suggestionTab(v, cat, title, intro, extra) {
    const applies = ['images', 'meta'].includes(cat);
    const [sug, done, st, applied] = await Promise.all([
      api('suggestions', { category: cat, status: 'suggested,approved' }), extra ? extra() : null,
      applies ? api('shopify-status').catch(() => ({ connected: false })) : null,
      applies ? api('suggestions', { category: cat, status: 'done' }).catch(() => ({ rows: [] })) : null,
    ]);
    const appliedRows = applied ? (applied.rows || []).filter((r) => r.applied_at).slice(0, 40) : [];
    const ready = st && st.connected && st.ok;
    const banner = !applies ? '' : !st || !st.connected
      ? `<div class="notice notice--coral"><span><b>Shopify isn't connected yet</b>, so "Apply to Shopify" won't work. ${esc((st && st.reason && st.reason !== 'not_configured') ? st.reason : 'Add the Shopify app credentials in Netlify.')}</span></div>`
      : !st.ok ? `<div class="notice notice--coral"><span><b>Connected to ${esc(st.shop)}</b>, but the app is missing: ${esc(st.missing.join(', '))}. Add those permissions to the app in Shopify.</span></div>` : '';
    const bulk = cat === 'images' && sug.rows.some(canApply)
      ? `<button class="btn btn--coral" id="apply-all" ${ready ? '' : 'disabled'} title="Adds every alt text below to the live site. Each one can be undone.">Apply all ${sug.rows.filter(canApply).length} to Shopify</button>` : '';
    v.innerHTML = `<div class="head"><div><h1>${esc(title)}</h1><p class="soft">${esc(intro)}</p></div>${bulk}</div>${banner}
      <div class="card" id="sl"><h3>Suggestions</h3>${suggestionList(sug.rows, 'New suggestions arrive every Monday, or press "Run weekly check now".')}</div>
      ${appliedRows.length ? `<div class="section card" id="al"><h3>Applied in Shopify</h3><div class="list">${appliedRows.map((r) => `<div class="item" data-sid="${r.id}"><div>${pill('done', 'Live')}</div><div class="item__main"><div class="item__title">${esc(r.title)}</div><div class="item__meta">${esc(ago(r.applied_at))}${r.page_url ? ' · ' + esc(r.page_url) : ''}</div>
        <div class="proposed">${r.applied.old && (r.applied.old.alt != null) ? `<div class="was">${esc(r.applied.old.alt || '(no alt text)')}</div><div class="now">${esc(r.applied.now.alt)}</div>` : `<div class="was">${esc((r.applied.old || {}).title || '(none)')}</div><div class="now">${esc((r.applied.now || {}).title || '')}</div>`}</div></div>
        <div class="item__actions"><button class="btn btn--sm btn--ghost" data-act="undo">Undo</button></div></div>`).join('')}</div></div>` : ''}
      <div id="extra"></div>`;
    wireSuggestions($('#sl'), sug.rows, () => go(cat));
    if ($('#al')) wireSuggestions($('#al'), appliedRows, () => go(cat));
    const ab = $('#apply-all');
    if (ab) ab.onclick = async () => {
      if (!confirm(`Add ${sug.rows.filter(canApply).length} alt texts to the live site now? You can undo any of them afterwards.`)) return;
      ab.disabled = true; ab.textContent = 'Applying in the background…';
      try { await post('apply-all', { category: 'images' }); toast('Applying alt texts in Shopify. Refresh in a few minutes.'); } catch (e) { toast(e.message); ab.disabled = false; }
    };
    return done;
  }

  VIEWS.onpage = async (v) => {
    const p = await suggestionTab(v, 'onpage', 'On-page content', 'Pages checked against the searches they should win: words used, headings, FAQs and links.', () => api('pages'));
    const rows = (p.pages || []).filter((x) => ['collection', 'page', 'home', 'blog'].includes(x.page_type) && x.status === 200).sort((a, b) => ((b.m && b.m.impressions) || 0) - ((a.m && a.m.impressions) || 0));
    $('#extra').innerHTML = `<div class="section card"><h3>Content pages</h3><div class="tablewrap"><table><thead><tr><th>Page</th><th>Main heading</th><th class="num">Words</th><th>FAQs</th><th class="num">Links in</th><th class="num">Shown (28d)</th><th class="num">Position</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 150).map((x) => `<tr><td><a href="https://baboodle.co.uk${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a></td><td>${esc(x.h1 || '—')}</td><td class="num ${x.word_count < 250 ? 'down' : ''}">${n0(x.word_count)}</td><td>${x.has_faq_schema ? pill('cited', 'Yes') : pill('low', 'No')}</td><td class="num ${!x.internal_links_in ? 'down' : ''}">${n0(x.internal_links_in)}</td><td class="num">${n0(x.m && x.m.impressions)}</td><td class="num">${pos(x.m && x.m.pos)}</td><td>${ask(`Page ${x.url}: H1 "${x.h1 || 'none'}", ${x.word_count} words, FAQs ${x.has_faq_schema ? 'yes' : 'no'}, ${x.internal_links_in} links in from other pages, shown ${x.m ? x.m.impressions : 0} times in 28 days at position ${pos(x.m && x.m.pos)}. Issues: ${(x.issues || []).map((i) => i.text).join('; ') || 'none'}. How do I improve this page's content?`)}</td></tr>`).join('') || '<tr><td colspan="8" class="soft">The site scan hasn\'t run yet.</td></tr>'}
    </tbody></table></div></div>`;
  };

  VIEWS.meta = async (v) => {
    const p = await suggestionTab(v, 'meta', 'Meta titles and descriptions', 'Pages where lots of people see you in Google but few click. Click the new wording to tweak it, then Apply to Shopify: it goes live straight away, is logged so the result is measured, and can be undone.', () => api('pages'));
    const rows = (p.pages || []).filter((x) => x.status === 200 && (x.issues || []).some((i) => /title|meta/.test(i.code)));
    $('#extra').innerHTML = `<div class="section card"><h3>Title and description issues (${rows.length})</h3><div class="tablewrap"><table><thead><tr><th>Page</th><th>Title</th><th>Issues</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 200).map((x) => `<tr><td class="url">${esc(x.url)}</td><td>${esc(x.title || '—')}<div class="url">${esc(x.meta_description || 'no description')}</div></td><td>${(x.issues || []).filter((i) => /title|meta/.test(i.code)).map((i) => esc(i.text)).join('<br>')}</td><td>${ask(`Page ${x.url}: Google title "${x.title || 'none'}", description "${x.meta_description || 'none'}". Issues: ${(x.issues || []).filter((i) => /title|meta/.test(i.code)).map((i) => i.text).join('; ')}. Write me a better title and description.`)}</td></tr>`).join('') || '<tr><td colspan="3" class="soft">No issues found.</td></tr>'}</tbody></table></div></div>`;
  };

  VIEWS.technical = async (v) => {
    const p = await suggestionTab(v, 'technical', 'Technical', 'From the weekly crawl of the live site: broken or redirected pages in the sitemap, missing headings, noindex, canonicals, duplicates, thin pages and orphan pages.', () => api('pages'));
    const groups = {};
    (p.pages || []).forEach((x) => (x.issues || []).forEach((i) => { if (['alt'].includes(i.code)) return; (groups[i.code] = groups[i.code] || { sev: i.sev, text: i.text.replace(/\b\d+\b/g, 'N').replace(/: N words/, '').replace(/^N /, 'Some '), urls: [] }).urls.push({ url: x.url, text: i.text }); }));
    const order = { high: 0, medium: 1, low: 2 };
    const list = Object.values(groups).sort((a, b) => order[a.sev] - order[b.sev] || b.urls.length - a.urls.length);
    $('#extra').innerHTML = `<div class="section card"><h3>Crawl findings · ${n0((p.pages || []).length)} pages scanned</h3><div class="list">
      ${list.map((g) => `<div class="item"><div>${pill(g.sev)}</div><div class="item__actions" style="order:3">${ask(`Technical issue from the site scan: "${g.text}" on ${g.urls.length} page(s), e.g. ${g.urls.slice(0, 8).map((u) => u.url).join(', ')}.`)}</div><div class="item__main"><details><summary>${esc(g.text)} · ${g.urls.length} page${g.urls.length === 1 ? '' : 's'}</summary><div class="proposed">${g.urls.slice(0, 60).map((u) => `${esc(u.url)} – ${esc(u.text)}`).join('<br>')}</div></details></div></div>`).join('') || '<p class="soft">The site scan hasn\'t run yet.</p>'}</div></div>`;
  };

  VIEWS.images = async (v) => {
    const p = await suggestionTab(v, 'images', 'Images and alt text', 'Alt text helps Google Images and screen readers. Claude writes it from the product and the image file. Click any text to edit it, then Apply to Shopify (one at a time or all at once). Every change can be undone.', () => api('pages'));
    $('#extra').innerHTML = `<div class="section grid g4"><div class="card kpi"><div class="label">Images checked</div><div class="num">${n0(p.images)}</div></div><div class="card kpi">${ask(`${p.images_no_alt} of ${p.images} images on baboodle.co.uk have no alt text, across ${(p.pages || []).filter((x) => x.img_missing_alt).length} pages.`)}<div class="label">Missing alt text</div><div class="num">${n0(p.images_no_alt)}</div></div><div class="card kpi"><div class="label">Pages affected</div><div class="num">${n0((p.pages || []).filter((x) => x.img_missing_alt).length)}</div></div></div>`;
  };

  VIEWS.blogs = async (v) => {
    const b = await api('blogs');
    v.innerHTML = `<div class="head"><div><h1>Blogs</h1><p class="soft">Ideas ranked by expected bookings, each with the strategy behind it. Demand uses how often you're shown in Google for those searches (Keyword Planner volumes will be added when connected).</p></div></div>
      <div id="bl">${b.rows.map(blogCard).join('') || '<div class="card empty"><h3>No blog ideas yet</h3><p>They arrive with the weekly check.</p></div>'}</div>`;
    v.onclick = async (e) => {
      const btn = e.target.closest('[data-blog]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.blog === 'toggle') { const s = $(`#s-${id}`); s.hidden = !s.hidden; btn.textContent = s.hidden ? 'See strategy' : 'Hide strategy'; }
      if (btn.dataset.blog === 'write') { btn.disabled = true; await post('write-draft', { id }); toast('Writing the draft. It takes 1–2 minutes.'); setTimeout(() => go('blogs'), 1500); }
      if (btn.dataset.blog === 'review') openDraft(id);
    };
  };

  function blogCard(b) {
    const c = b.conversion || {}, cl = b.cluster || {}, o = b.outline || {}, r = b.ranking || {};
    return `<div class="card" style="margin-bottom:12px">
      <div class="head" style="margin:0"><div><h3>${esc(b.title)}</h3><p class="soft small">${n0(b.total_demand)} ${(b.cluster && (b.cluster.queries || []).some((q) => q.monthly_searches != null)) ? 'searches' : 'times shown'} a month · feeds ${esc(b.target_page || '—')} · about <b>${c.bookings != null ? c.bookings : '—'}</b> bookings a month</p>${b.strategy_score != null ? `<p style="margin:4px 0 0">${fit(b.strategy_score, b.strategy_note)}</p>` : ''}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${pill(b.status)}${ask(`Blog idea "${b.title}" (feeds ${b.target_page}, ${b.total_demand} views a month, about ${c.bookings} bookings a month expected, status ${b.status}).`)}<button class="btn btn--sm" data-blog="toggle" data-id="${b.id}">See strategy</button>
        ${b.status === 'idea' ? `<button class="btn btn--sm btn--coral" data-blog="write" data-id="${b.id}">Write draft</button>` : ''}${['draft_ready', 'in_shopify'].includes(b.status) ? `<button class="btn btn--sm btn--coral" data-blog="review" data-id="${b.id}">Review draft</button>` : ''}</div></div>
      <div id="s-${b.id}" hidden>
        <div class="strategy">
          <div><h4>What people are searching</h4><p class="small" style="margin:0 0 8px">${esc(b.intent || '')}</p>
            <table><thead><tr><th>Search</th><th class="num">Monthly searches</th><th class="num">Shown (28d)</th><th class="num">You now</th></tr></thead><tbody>
            ${(cl.queries || []).map((q) => `<tr><td>${esc(q.query)}</td><td class="num">${q.monthly_searches != null ? n0(q.monthly_searches) : '—'}</td><td class="num">${n0(q.impressions_28d)}</td><td class="num">${pos(q.position)}</td></tr>`).join('')}</tbody></table>
            ${(cl.extra_searches || []).length ? `<p class="small" style="margin:8px 0 0"><b>Related:</b> ${cl.extra_searches.map(esc).join(' · ')}</p>` : ''}
            ${(cl.questions || []).length ? `<p class="small" style="margin:6px 0 0"><b>Questions they ask:</b> ${cl.questions.map(esc).join(' · ')}</p>` : ''}</div>
          <div><h4>What it covers</h4><ol>${(o.sections || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
            ${(o.products || []).length ? `<p class="small" style="margin:8px 0 0"><b>Products featured:</b> ${o.products.map(esc).join(', ')}</p>` : ''}
            ${o.angle ? `<p class="small" style="margin:6px 0 0"><b>Why it beats what ranks now:</b> ${esc(o.angle)}</p>` : ''}</div>
          <div><h4>Where it should rank</h4><p class="small" style="margin:0">Top ${esc(r.target_position || 5)} for "<b>${esc(r.main_search || '')}</b>" within ${esc(r.timeframe || '3 months')} · difficulty ${pill(r.difficulty === 'high' ? 'high' : r.difficulty === 'low' ? 'positive' : 'medium', r.difficulty || 'medium')}</p>
            ${(r.currently_ranking || []).length ? `<p class="small" style="margin:8px 0 4px"><b>Ranking now:</b></p><ol>${r.currently_ranking.map((x) => `<li>${esc(x.name)}${x.note ? ` – <span class="soft">${esc(x.note)}</span>` : ''}</li>`).join('')}</ol>` : ''}
            ${r.bonus ? `<p class="small" style="margin:6px 0 0"><b>Bonus spots:</b> ${esc(r.bonus)}</p>` : ''}</div>
          <div><h4>How it could convert</h4><div class="funnel"><div><span class="tiny soft">Shown a month</span><b>${n0(c.monthly_demand)}</b></div><div><span class="tiny soft">Clicks at #${esc(c.target_position)}</span><b>${n0(c.clicks)}</b></div><div><span class="tiny soft">Visit a hire page</span><b>${n0(c.to_hire_page)}</b></div><div><span class="tiny soft">Book (${pct(c.booking_rate)})</span><b>${c.bookings != null ? c.bookings : '—'}</b></div></div>
            ${c.path ? `<p class="small" style="margin:8px 0 0">${esc(c.path)}</p>` : ''}</div>
        </div>
      </div></div>`;
  }

  async function openDraft(id) {
    const b = await api('blog', { id });
    const v = $('#view');
    v.innerHTML = `<p><button class="btn btn--sm btn--ghost" id="back">← Back to blogs</button></p>
      <div class="head"><div><h1>${esc(b.title)}</h1><p class="soft">${pill(b.status)} · feeds ${esc(b.target_page || '')}</p></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn" id="save">Save edits</button><button class="btn btn--coral" id="send">${b.status === 'in_shopify' ? 'Send again to Shopify' : 'Send to Shopify as draft'}</button></div></div>
      <div class="grid" style="grid-template-columns:minmax(0,1.7fr) minmax(0,1fr)">
        <div class="card editor"><label>Google title (<span id="tl">0</span>/60)</label><input id="mt" value="${esc(b.meta_title || '')}">
          <label>Google description (<span id="dl">0</span>/155)</label><textarea id="md" rows="2">${esc(b.meta_description || '')}</textarea>
          <label>Post (HTML, edit freely)</label><textarea id="html" rows="10" style="font-family:monospace;font-size:13px">${esc(b.draft_html || '')}</textarea>
          <label>Preview</label><div class="preview" id="pv"></div></div>
        <div class="grid" style="align-content:start">
          <div class="card"><h3>Checks</h3>${(b.checks || []).map((c) => `<div class="check">${c.ok ? '<span class="up">✓</span>' : '<span class="down">!</span>'}<span>${esc(c.text)}</span></div>`).join('') || '<p class="soft">No checks.</p>'}
            <p class="tiny soft" style="margin:10px 0 0">Anything marked [CHECK: …] in the post needs your sign-off before publishing.</p></div>
          <div class="card card--lav"><h3>After you publish</h3><p class="small" style="margin:0">Publish it in Shopify when you're happy, then log it as a change. The dashboard tracks its clicks, position and AI mentions.</p></div>
        </div></div>`;
    const sync = () => { $('#tl').textContent = $('#mt').value.length; $('#dl').textContent = $('#md').value.length; $('#pv').innerHTML = $('#html').value.replace(/<script[\s\S]*?<\/script>/gi, ''); };
    ['mt', 'md', 'html'].forEach((i) => $('#' + i).addEventListener('input', sync)); sync();
    $('#back').onclick = () => go('blogs');
    $('#save').onclick = async () => { await post('save-blog', { id, meta_title: $('#mt').value, meta_description: $('#md').value, draft_html: $('#html').value }); toast('Saved'); };
    $('#send').onclick = async (e) => {
      e.target.disabled = true;
      try { await post('save-blog', { id, meta_title: $('#mt').value, meta_description: $('#md').value, draft_html: $('#html').value }); await post('send-blog', { id }); toast('In Shopify as an unpublished draft'); openDraft(id); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    };
  }

  VIEWS.aeo = async (v) => {
    const [a, sug] = await Promise.all([api('aeo'), api('suggestions', { category: 'aeo', status: 'suggested,approved' })]);
    const s = a.summary;
    v.innerHTML = `<div class="head"><div><h1>AI mentions</h1><p class="soft">Every Monday Claude is asked the questions parents ask, with live web search. Does it name Baboodle, link to you, or recommend someone else?</p></div></div>
      <div class="grid g4"><div class="card kpi"><div class="label">Questions checked</div><div class="num">${n0(s.checked)}</div></div><div class="card kpi"><div class="label">Baboodle named</div><div class="num">${n0(s.mentioned)}</div></div><div class="card kpi"><div class="label">Cited with a link</div><div class="num">${n0(s.cited)}</div></div>
        <div class="card kpi card--lav"><div class="label">Named instead</div><div class="small" style="margin-top:6px">${(s.competitors || []).map(([c, k]) => `${esc(c)} (${k})`).join('<br>') || '—'}</div></div></div>
      <div class="section card" id="asug"><h3>How to get mentioned more</h3>${suggestionList(sug.rows, 'Suggestions arrive after the first AI check.')}</div>
      <div class="section card"><div class="head" style="margin-bottom:6px"><h3>Questions</h3><form id="addq" style="display:flex;gap:6px"><input name="question" required placeholder="Add a question parents ask" style="padding:7px 12px;border:1px solid var(--line);border-radius:30px;font:inherit;min-width:260px"><button class="btn btn--sm">Add</button></form></div>
        <div class="tablewrap"><table><thead><tr><th>Question</th><th>Latest</th><th>Last 6 weeks</th><th>Named instead</th><th></th></tr></thead><tbody>
        ${a.rows.map((r) => `<tr style="${r.active ? '' : 'opacity:.5'}"><td>${esc(r.question)}${r.latest && r.latest.answer ? `<details><summary class="tiny soft">Claude's answer</summary><div class="proposed">${esc(r.latest.answer)}</div></details>` : ''}</td><td>${r.latest ? pill(r.latest.status) : pill('not', 'Not checked')}</td>
          <td><div class="dots">${r.history.slice().reverse().map((h) => `<span class="dot ${esc(h.status)}" title="${esc(label[h.status] || h.status)} · ${day(h.at)}"></span>`).join('')}</div></td>
          <td class="small">${esc(((r.latest && r.latest.competitors) || []).join(', '))}</td><td style="white-space:nowrap">${ask(`AI question "${r.question}": latest result ${r.latest ? label[r.latest.status] || r.latest.status : 'not checked'}; named instead: ${((r.latest && r.latest.competitors) || []).join(', ') || 'nobody'}. How do I get Baboodle cited for this?`)}<button class="btn btn--sm btn--ghost" data-q="${r.id}" data-on="${r.active ? 0 : 1}">${r.active ? 'Pause' : 'Resume'}</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    wireSuggestions($('#asug'), sug.rows, () => go('aeo'));
    $('#addq').onsubmit = async (e) => { e.preventDefault(); await post('question', { question: new FormData(e.target).get('question') }); toast('Added. It\'s checked from next Monday.'); go('aeo'); };
    v.querySelectorAll('[data-q]').forEach((b) => (b.onclick = async () => { await post('question', { id: b.dataset.q, active: b.dataset.on === '1' }); go('aeo'); }));
  };

  VIEWS.strategy = async (v) => {
    const st = await api('strategy');
    v.innerHTML = `<div class="head"><div><h1>Strategy</h1><p class="soft">What the search brain is working towards. Every suggestion, blog idea, weekly plan and chat answer is weighted towards this, so keep it up to date when your priorities change.${st.updated_at ? ' Last saved ' + ago(st.updated_at) + '.' : ''}</p></div><button class="btn btn--coral" id="save-st">Save strategy</button></div>
      <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
        <div class="card editor"><label>Your strategy (plain text; headings with ## and bullet points with - work fine)</label><textarea id="st" rows="30" style="font-size:15px;line-height:1.6">${esc(st.value || '')}</textarea></div>
        <div class="grid" style="align-content:start">
          <div class="card card--lav"><h3>What helps most</h3><ul class="small" style="margin:0;padding-left:18px"><li>Which customers you want more of, and why</li><li>Categories and products to push, in order</li><li>Products <b>not</b> to push (no stock, not profitable, being phased out)</li><li>Seasonal pushes coming up</li><li>Facts that give you authority (your own data)</li><li>Rules: FCA, brand, pages that must stay as they are</li></ul></div>
          <div class="card"><h3>When it takes effect</h3><p class="small" style="margin:0">Straight away in the chat. When you save, every open blog idea and suggestion is re-scored against it and this week's 3-hour plan is rebuilt (takes a minute or two). New suggestions and blog ideas follow it from the next weekly check.</p></div>
        </div></div>`;
    $('#save-st').onclick = async () => { await post('save-strategy', { value: $('#st').value }); toast('Strategy saved. Re-scoring ideas and rebuilding this week\'s plan around it, give it a minute or two.'); };
  };

  VIEWS.results = async (v) => {
    const r = await api('results');
    v.innerHTML = `<div class="head"><div><h1>Results</h1><p class="soft">Every suggestion you mark done is measured 28 days later: clicks and position on that page, 28 days before vs 28 days after.</p></div></div>
      <div class="card"><div class="tablewrap"><table><thead><tr><th>Change</th><th>Done</th><th class="num">Clicks before</th><th class="num">Clicks after</th><th class="num">Position</th><th>Result</th><th></th></tr></thead><tbody>
      ${r.rows.map((s) => { const x = s.result || {}; return `<tr><td>${esc(s.title)}<div class="url">${esc(s.page_url || '')}</div></td><td>${s.actioned_at ? day(s.actioned_at.slice(0, 10)) : '—'}</td><td class="num">${n0(x.clicks_before)}</td><td class="num">${n0(x.clicks_after)}</td><td class="num">${x.position_before ? `${pos(x.position_before)} → ${pos(x.position_after)}` : '—'}</td><td>${x.verdict ? pill(x.verdict) : pill('too_early', 'Measuring')}</td><td>${ask(`Result of "${s.title}" (${s.page_url || ''}, done ${s.actioned_at ? s.actioned_at.slice(0, 10) : ''}): clicks ${x.clicks_before ?? 'n/a'} → ${x.clicks_after ?? 'n/a'}, position ${x.position_before ?? 'n/a'} → ${x.position_after ?? 'n/a'}, verdict ${x.verdict || 'still measuring'}. What should I do next?`)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="soft">Nothing marked done yet.</td></tr>'}
      </tbody></table></div></div>`;
  };

  document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });

  // ---------- Ask Claude ----------
  const STARTERS = ['How are we doing this week compared with last week?', 'What should I spend my 3 hours on this week?', 'Which searches could reach the top 3 with a small change?', 'Has the pram hire hub redesign helped yet?', 'Why aren\'t we mentioned by AI for travel pram questions?'];
  let threadId = localStorage.getItem('bb_chat_thread') || newThread();
  let polling = null;
  function newThread() { const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); localStorage.setItem('bb_chat_thread', id); return id; }
  function md(t) {
    let h = esc(t);
    h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\n)#{1,4} (.+)/g, '$1<h4>$2</h4>');
    const lines = h.split('\n'); let out = '', list = null;
    for (const l of lines) {
      const ul = l.match(/^\s*[-•*] (.+)/), ol = l.match(/^\s*\d+[.)] (.+)/);
      if (ul || ol) { const tag = ul ? 'ul' : 'ol'; if (list !== tag) { if (list) out += `</${list}>`; out += `<${tag}>`; list = tag; } out += `<li>${(ul || ol)[1]}</li>`; continue; }
      if (list) { out += `</${list}>`; list = null; }
      if (l.trim().startsWith('<h4>')) out += l; else if (l.trim()) out += `<p>${l}</p>`;
    }
    if (list) out += `</${list}>`;
    return out;
  }
  function renderChat(rows) {
    const box = $('#chat-msgs');
    if (!rows.length) {
      box.innerHTML = `<p class="small soft" style="margin:0 0 4px">Ask anything about Baboodle's search traffic, pages, rankings, AI mentions or what to do next. Try:</p><div class="chat__starters">${STARTERS.map((q) => `<button data-starter="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
      return;
    }
    box.innerHTML = rows.map((m) => `<div class="msg msg--${m.role}${m.status === 'pending' ? ' msg--pending' : ''}${m.status === 'error' ? ' msg--error' : ''}">${m.role === 'assistant' && m.status === 'done' ? md(m.content) : esc(m.content)}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }
  async function loadChat() {
    const r = await api('chat', { thread_id: threadId });
    renderChat(r.rows);
    const pending = r.rows.some((m) => m.status === 'pending');
    clearTimeout(polling);
    if (pending) polling = setTimeout(loadChat, 1500);
  }
  async function sendChat(text) {
    if (!text.trim()) return;
    $('#chat-input').value = '';
    const box = $('#chat-msgs');
    if (box.querySelector('.chat__starters')) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', `<div class="msg msg--user">${esc(text)}</div><div class="msg msg--assistant msg--pending">Thinking…</div>`);
    box.scrollTop = box.scrollHeight;
    try { await post('chat-send', { thread_id: threadId, text }); loadChat(); } catch (err) { toast(err.message); }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ask]');
    if (!b) return;
    e.stopPropagation();
    $('#chat').hidden = false; $('#chat-open').hidden = true;
    threadId = newThread();
    renderChat([]);
    sendChat(`What should I do about this, and what outcome should I expect?\n\n${b.dataset.ask}`);
  });
  $('#chat-open').onclick = () => { $('#chat').hidden = false; $('#chat-open').hidden = true; loadChat(); $('#chat-input').focus(); };
  $('#chat-close').onclick = () => { $('#chat').hidden = true; $('#chat-open').hidden = false; clearTimeout(polling); };
  $('#chat-new').onclick = () => { threadId = newThread(); renderChat([]); };
  $('#chat-form').onsubmit = (e) => { e.preventDefault(); sendChat($('#chat-input').value); };
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('#chat-input').value); } });
  $('#chat-msgs').addEventListener('click', (e) => { const b = e.target.closest('[data-starter]'); if (b) sendChat(b.dataset.starter); });

  async function start() {
    $('#gate').hidden = true; $('#app').hidden = false;
    const p = new URLSearchParams(location.search);
    if (p.get('gsc')) { history.replaceState(null, '', '/' + location.hash); setTimeout(() => toast(p.get('gsc') === 'connected' ? 'Search Console connected. Loading 90 days of data…' : 'Search Console: ' + p.get('gsc')), 300); }
    const h = location.hash.slice(1);
    go(TABS.some(([id]) => id === h) ? h : 'overview');
    if (h && h !== 'overview') api('overview').then((o) => { cache.todo = o.todo; renderTabs(o.todo); renderStatus(o); }).catch(() => {});
    setInterval(() => api('overview').then((o) => { renderStatus(o); }).catch(() => {}), 60000);
  }

  if (pass) api('overview').then(start).catch(() => showGate(false)); else showGate(false);
})();
