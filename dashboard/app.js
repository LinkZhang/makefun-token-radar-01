/* Token Radar dashboard: renders window.RADAR (written by main.ts) with no
 * network. Sortable board, filters, a detail view per protocol, a live-token
 * view, and the model stated in full. Deep links: #slug=<slug> opens a
 * detail view; #cat=<category> and #q=<text> pre-apply filters. */
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.getElementById('rows').innerHTML = '<tr><td colspan="8">No radar data found.</td></tr>'; return; }

  var MULTS = [
    ['Derivatives', '0.30', 'Perpetuals and options books earn fees on every trade.'],
    ['Lending', '0.28', 'Interest spreads are steady, audited revenue.'],
    ['RWA', '0.28', 'Real-world yield pays a spread the protocol keeps.'],
    ['Risk Curators', '0.26', 'Curators take a cut of the vaults they run.'],
    ['Onchain Capital Allocator', '0.26', 'Allocators earn fees on the capital they place.'],
    ['Dexs', '0.25', 'Swap fees scale with volume, not with TVL alone.'],
    ['CDP', '0.25', 'Borrowing against collateral earns a stability fee.'],
    ['Basis Trading', '0.24', 'Funding-rate capture, thinner than lending.'],
    ['Yield', '0.22', 'Yield is often paid out, not kept.'],
    ['Yield Aggregator', '0.22', 'Aggregators split the yield they route.'],
    ['Liquidity Manager', '0.22', 'Management fees on concentrated liquidity.'],
    ['Liquid Staking', '0.15', 'A small fee on staking rewards.'],
    ['Staking Pool', '0.15', 'A small fee on staking rewards.'],
    ['Bridge', '0.12', 'Bridges move value; they keep little of it.'],
    ['Canonical Bridge', '0.12', 'Bridges move value; they keep little of it.'],
    ['Other / none', '0.20', 'Default multiple for any other category.']
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(n) {
    if (n == null) return '—';
    var s = (n > 0 ? '+' : '') + n.toFixed(1) + '%';
    return '<span class="' + (n > 0 ? 'up' : n < 0 ? 'down' : '') + '">' + s + '</span>';
  }
  function age(a) {
    if (a == null) return '—';
    if (a >= 365) return (a / 365).toFixed(1) + 'y';
    return a + 'd';
  }
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { el.addEventListener(ev, fn); }

  /* ---- header stats ---- */
  var top = D.rows[0];
  $('stats').innerHTML =
    '<div><dt>Protocols ranked</dt><dd>' + D.rows.length + '</dd></div>' +
    '<div><dt>Watchlist covered</dt><dd>' + D.watchlist_size + ' / ' + D.watchlist_size + '</dd></div>' +
    '<div><dt>Early finds</dt><dd>' + D.early_size + '</dd></div>' +
    '<div><dt>Top implied value</dt><dd>' + money(top ? top.implied_value_usd : 0) + '</dd></div>' +
    '<div><dt>Live tokens set aside</dt><dd>' + D.live_size + '</dd></div>';
  $('src').textContent = 'Snapshot: DefiLlama protocols, fetched 2026-11-14 · watchlist floor ' +
    moneyFull(D.floor_usd) + ' TVL · model ' + esc(D.model_version);

  /* ---- filter controls ---- */
  var cats = [], chains = [];
  D.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) { $('cat').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });
  chains.forEach(function (c) { $('chain').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });
  var state = { q: '', cat: '', chain: '', watch: false, sort: 'value', key: null, dir: 1, tab: 'board', slug: null };

  function isWatch(r) { return r.on_watchlist === true; }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = D.rows.filter(function (r) {
      if (state.watch && !isWatch(r)) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
    var k = state.key || state.sort;
    var dir = state.key ? state.dir : (k === 'name' ? 1 : -1);
    var val = {
      rank: function (r) { return r.rank; },
      name: function (r) { return r.name.toLowerCase(); },
      category: function (r) { return (r.category || '').toLowerCase(); },
      chains: function (r) { return (r.chains[0] || '').toLowerCase(); },
      tvl: function (r) { return r.tvl_usd; },
      growth: function (r) { return r.change_7d == null ? -Infinity : r.change_7d; },
      age: function (r) { return r.age_days == null ? -1 : r.age_days; },
      value: function (r) { return r.implied_value_usd; }
    }[k] || function (r) { return r.implied_value_usd; };
    rows.sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.rank - b.rank;
    });
    return rows;
  }

  function renderBoard() {
    var rows = filtered();
    $('count').textContent = rows.length + ' of ' + D.rows.length + ' protocols';
    var html = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.slug === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td>' + esc(r.name) + (isWatch(r) ? '<span class="badge">WATCHLIST</span>' : '') +
        '<span class="sub">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + age(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>';
    }).join('');
    $('rows').innerHTML = html || '<tr><td colspan="8">No protocols match these filters.</td></tr>';
    var trs = $('rows').querySelectorAll('tr[data-slug]');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { openDetail(this.getAttribute('data-slug')); });
    }
  }

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    var box = $('detail');
    if (!r) { box.hidden = true; state.slug = null; return; }
    state.slug = slug;
    var m = r.model;
    var steps = r.farm_steps.map(function (s, i) {
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(s) + '</li>';
    }).join('');
    box.innerHTML =
      '<h2>#' + r.rank + ' · ' + esc(r.name) + (isWatch(r) ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="meta">' + esc(r.category || 'No category') + ' · ' + esc(r.chains.join(', ')) +
      ' · TVL ' + moneyFull(r.tvl_usd) + ' · 7-day ' + (r.change_7d == null ? 'not reported' : r.change_7d.toFixed(1) + '%') +
      ' · listed ' + esc(r.listed_at || 'unknown') + ' · no token recorded</p>' +
      '<h3>Implied value: ' + moneyFull(r.implied_value_usd) + '</h3>' +
      '<p class="math">TVL ' + moneyFull(r.tvl_usd) + ' × category ' + m.category_multiple.toFixed(2) +
      ' × momentum ' + m.momentum.toFixed(2) + ' (7d ' + m.growth_pct.toFixed(1) + '%)' +
      ' × seasoning ' + m.seasoning.toFixed(2) + ' (' + (r.age_days == null ? 'age unknown, scored at 365d' : r.age_days + ' days') + ')' +
      ' × breadth ' + m.breadth.toFixed(2) + ' (' + r.chains.length + ' chains)<br>= <b>' + moneyFull(r.implied_value_usd) + '</b></p>' +
      '<h3>Farm plan</h3><ol>' + steps + '</ol>' +
      '<p class="meta">The plan is generated from this protocol\u2019s own record — category, chain, size and age — not from a hand-written list.</p>';
    box.hidden = false;
    renderBoard();
    box.scrollIntoView({ block: 'start' });
  }

  /* ---- live view ---- */
  $('liverows').innerHTML = D.live.map(function (r) {
    return '<tr><td>' + esc(r.name) + '<span class="sub">' + esc(r.slug) + '</span></td>' +
      '<td>' + esc(r.category || '—') + '</td><td>' + esc(r.chains.slice(0, 3).join(', ')) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num">' + money(r.mcap_usd) + '</td>' +
      '<td class="num">' + pct(r.change_7d) + '</td></tr>';
  }).join('');

  /* ---- model tab ---- */
  $('mults').querySelector('tbody').innerHTML = MULTS.map(function (m) {
    return '<tr><td>' + esc(m[0]) + '</td><td class="num">' + m[1] + '</td><td>' + esc(m[2]) + '</td></tr>';
  }).join('');

  /* ---- tabs ---- */
  function showTab(tab) {
    state.tab = tab;
    var btns = $('tabs').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === tab);
    $('tab-board').hidden = tab !== 'board';
    $('tab-live').hidden = tab !== 'live';
    $('tab-model').hidden = tab !== 'model';
  }
  var tabBtns = $('tabs').querySelectorAll('button');
  for (var j = 0; j < tabBtns.length; j++) {
    tabBtns[j].addEventListener('click', function () { showTab(this.getAttribute('data-tab')); });
  }

  /* ---- controls ---- */
  on($('q'), 'input', function () { state.q = this.value; renderBoard(); });
  on($('cat'), 'change', function () { state.cat = this.value; renderBoard(); });
  on($('chain'), 'change', function () { state.chain = this.value; renderBoard(); });
  on($('watch'), 'change', function () { state.watch = this.checked; renderBoard(); });
  on($('sort'), 'change', function () { state.sort = this.value; state.key = null; renderBoard(); });
  var ths = document.querySelectorAll('#board th[data-k]');
  for (var k = 0; k < ths.length; k++) {
    ths[k].addEventListener('click', function () {
      var key = this.getAttribute('data-k');
      if (state.key === key) { state.dir = -state.dir; }
      else { state.key = key; state.dir = key === 'name' || key === 'category' || key === 'chains' ? 1 : -1; }
      renderBoard();
    });
  }

  /* ---- deep links: #slug=, #cat=, #q=, #watch=1 ---- */
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (part) {
      var kv = part.split('=');
      var key = decodeURIComponent(kv[0] || '');
      var val = decodeURIComponent(kv[1] || '');
      if (key === 'slug' && val) state.slug = val;
      if (key === 'cat' && val) { state.cat = val; $('cat').value = val; }
      if (key === 'q' && val) { state.q = val; $('q').value = val; }
      if (key === 'watch' && val === '1') { state.watch = true; $('watch').checked = true; }
    });
  }
  readHash();
  renderBoard();
  if (state.slug) openDetail(state.slug);
})();
