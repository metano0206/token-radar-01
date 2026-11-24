/* Token Launch Radar — the board page. Renders window.TOKEN_RADAR (written by main.ts as
   ../data.js from the same board it hands in), with search, filters, five sort orders and a
   detail view per protocol. State lives in the location hash, so a view can be linked:
   #p=<slug> opens a protocol, #cat=, #chain=, #watch=1, #q= and #sort= set the board. */
'use strict';

const DATA = window.TOKEN_RADAR;
const rows = DATA.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

const $ = (id) => document.getElementById(id);
const els = {
  meta: $('meta-line'), universe: $('universe'), q: $('q'), cat: $('cat'), chain: $('chain'),
  sort: $('sort'), watch: $('watch'), count: $('count'), tbody: $('rows'), empty: $('empty'),
  detail: $('detail'), fine: $('fine-line'),
};

function money(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}
function pct(v) {
  if (v === null || v === undefined) return '<span class="flat">—</span>';
  const cls = v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}
function ageText(days) {
  if (days >= 730) return `${(days / 365.25).toFixed(1)}y`;
  if (days >= 60) return `${Math.round(days / 30.4)}mo`;
  return `${days}d`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- header, universe, footer ---- */
els.meta.innerHTML =
  `Snapshot <strong>${esc(DATA.as_of)}</strong> · DefiLlama protocols at $5M TVL and above · ` +
  `model <strong>${esc(DATA.model_version)}</strong> · the watchlist floor is ${money(DATA.floor_usd)}`;
els.universe.innerHTML = [
  [DATA.counts.tracked, 'protocols tracked in the snapshot', ''],
  [DATA.counts.tokenized, 'already record a token — set aside, never ranked', ''],
  [DATA.counts.products, 'record no token but are a product of one that trades — set aside', ''],
  [DATA.counts.ranked, `ranked on the board · ${DATA.counts.watchlist} of them on the watchlist`, 'hot'],
  [money(DATA.total_implied_usd), 'of implied launch value across the whole board', ''],
  [`${DATA.median_multiple.toFixed(2)}×`, 'median peer multiple applied to a row', ''],
]
  .map(([n, label, cls]) => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`)
  .join('');
els.fine.textContent =
  `Board generated from the sealed snapshot of ${DATA.as_of}. Global peer multiple across all categories: ${DATA.global_multiple.toFixed(3)}.`;

/* ---- controls ---- */
const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
for (const c of categories) els.cat.insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`);
const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
for (const c of chains) els.chain.insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`);

function state() {
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    q: h.get('q') || '', cat: h.get('cat') || '', chain: h.get('chain') || '',
    watch: h.get('watch') === '1', sort: h.get('sort') || 'rank', p: h.get('p') || '',
  };
}
function saveState(patch) {
  const s = { ...state(), ...patch };
  const h = new URLSearchParams();
  if (s.q) h.set('q', s.q);
  if (s.cat) h.set('cat', s.cat);
  if (s.chain) h.set('chain', s.chain);
  if (s.watch) h.set('watch', '1');
  if (s.sort && s.sort !== 'rank') h.set('sort', s.sort);
  if (s.p) h.set('p', s.p);
  history.replaceState(null, '', h.toString() ? `#${h}` : location.pathname);
  render();
}

const SORTERS = {
  rank: (a, b) => a.rank - b.rank,
  tvl: (a, b) => b.tvl_usd - a.tvl_usd,
  growth: (a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity),
  age: (a, b) => b.age_days - a.age_days,
  name: (a, b) => a.name.localeCompare(b.name),
};

function visible() {
  const s = state();
  const q = s.q.trim().toLowerCase();
  const list = rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!s.cat || r.category === s.cat) &&
    (!s.chain || r.chains.includes(s.chain)) &&
    (!s.watch || r.watchlist));
  return list.sort(SORTERS[s.sort] || SORTERS.rank);
}

function rowHtml(r, selected) {
  return `<tr data-slug="${esc(r.slug)}"${r.slug === selected ? ' class="selected"' : ''}>
    <td class="num rank">${r.rank}</td>
    <td><span class="pname">${esc(r.name)}</span>${r.watchlist ? '<span class="chip">Watchlist</span>' : ''}<span class="pslug">${esc(r.slug)}</span></td>
    <td>${esc(r.category ?? '—')}</td>
    <td>${esc(r.chains.slice(0, 3).join(', '))}${r.chains.length > 3 ? ` +${r.chains.length - 3}` : ''}</td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num">${pct(r.change_7d)}</td>
    <td class="num">${ageText(r.age_days)}</td>
    <td class="num">${r.peer_multiple.toFixed(2)}×</td>
    <td class="num"><strong>${money(r.implied_value_usd)}</strong></td>
  </tr>`;
}

/* ---- detail view ---- */
const peerSets = new Map((DATA.peer_sets || []).map((s) => [s.category, s]));

function rangeHtml(r) {
  const rg = DATA.ranges[r.slug];
  if (!rg) return '';
  const span = rg.hi - rg.lo;
  const at = span > 0 ? Math.min(100, Math.max(0, ((r.implied_value_usd - rg.lo) / span) * 100)) : 50;
  return `<div class="range">
    <div class="range-head"><span>Implied range · peer 25th–75th percentile</span><b>${money(rg.lo)} – ${money(rg.hi)}</b></div>
    <div class="rangebar"><i style="left:${at.toFixed(1)}%"></i></div>
    <p class="range-note">The point estimate prices this protocol at its peer median, ${r.peer_multiple.toFixed(2)}×.
    Priced at the peer set's 25th percentile multiple (${rg.mlo.toFixed(2)}×) the same TVL and factors give ${money(rg.lo)};
    at the 75th (${rg.mhi.toFixed(2)}×), ${money(rg.hi)}. The marker sits at the point estimate.</p>
  </div>`;
}

function peersHtml(r) {
  const set = r.category ? peerSets.get(r.category) : undefined;
  if (!set) {
    return `<h3>The peer set</h3>
  <p class="working-note">No protocol in ${esc(r.category ?? 'this category')} records a token with a market cap in the
  snapshot, so there is no category peer set to price from: the model falls back to the global peer median,
  ${DATA.global_multiple.toFixed(2)}×, and the range above reads the global peer spread.</p>`;
  }
  const body = set.peers
    .map((p) => `<tr><td><span class="pname">${esc(p.name)}</span><span class="pslug">${esc(p.slug)}</span></td><td class="num">${money(p.mcap_usd)}</td><td class="num">${money(p.tvl_usd)}</td><td class="num">${p.multiple.toFixed(2)}×</td></tr>`)
    .join('');
  return `<h3>The peer set behind the multiple</h3>
  <p class="working-note">${set.peers.length} tokenized peer${set.peers.length === 1 ? '' : 's'} in ${esc(set.category)},
  each priced at its market cap over its TVL, winsorized to the pooled band. Their median is ${set.median.toFixed(2)}×;
  shrunk toward the global median of ${DATA.global_multiple.toFixed(2)}×, it applies to this row as ${r.peer_multiple.toFixed(2)}×.</p>
  <div class="table-scroll peers-scroll"><table class="peers">
    <thead><tr><th>Peer</th><th class="num">Market cap</th><th class="num">TVL</th><th class="num">Cap / TVL</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function detailHtml(r) {
  const growth = r.change_7d === null ? 'no change reported (factor 1.00)' :
    `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}% over seven days (factor ${r.growth_factor.toFixed(2)})`;
  const peerNote = r.peer_count > 0
    ? `Its category, ${esc(r.category)}, has ${r.peer_count} tokenized peer${r.peer_count === 1 ? '' : 's'} in the snapshot; their median market-cap/TVL, shrunk toward the global median, gives the ${r.peer_multiple.toFixed(2)}× multiple.`
    : `Its category has no tokenized peer with a market cap in the snapshot, so the global peer median of ${DATA.global_multiple.toFixed(2)}× is used.`;
  return `
  <div class="head">
    <h2>${esc(r.name)}</h2>${r.watchlist ? '<span class="chip">Watchlist</span>' : ''}
    <span class="sub">rank ${r.rank} of ${rows.length} · ${esc(r.slug)} · ${esc(r.category ?? 'uncategorised')} · ${esc(r.chains.join(', '))}</span>
    <button class="close" id="close-detail" type="button">Close</button>
  </div>
  <div class="stats">
    <div><b>${money(r.implied_value_usd)}</b><span>implied launch value</span></div>
    <div><b>${money(r.tvl_usd)}</b><span>TVL in the snapshot</span></div>
    <div><b>${r.listed_at ?? 'unreported'}</b><span>tracked since · ${ageText(r.age_days)} of tokenless record</span></div>
    <div><b>${r.change_7d === null ? '—' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</b><span>TVL change, 7 days</span></div>
  </div>
  <p class="working">${money(r.tvl_usd)} × ${r.peer_multiple.toFixed(2)} × ${r.growth_factor.toFixed(2)} × ${r.maturity_factor.toFixed(2)} = ${money(r.implied_value_usd)}</p>
  <p class="working-note">${peerNote} Growth: ${growth}. Maturity: a tokenless record of ${ageText(r.age_days)} gives factor ${r.maturity_factor.toFixed(2)} on the model's 0.75–1.00 scale.</p>
  ${rangeHtml(r)}
  ${peersHtml(r)}
  <h3>Farm plan</h3>
  <ol class="plan">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
}

let firstRender = true;
function render() {
  const s = state();
  els.q.value = s.q; els.cat.value = s.cat; els.chain.value = s.chain;
  els.sort.value = s.sort; els.watch.checked = s.watch;
  const list = visible();
  els.count.textContent = `${list.length} of ${rows.length} protocols shown`;
  els.tbody.innerHTML = list.map((r) => rowHtml(r, s.p)).join('');
  els.empty.hidden = list.length > 0;
  const sel = s.p ? bySlug.get(s.p) : undefined;
  els.detail.hidden = !sel;
  if (sel) {
    els.detail.innerHTML = detailHtml(sel);
    $('close-detail').addEventListener('click', () => saveState({ p: '' }));
    if (firstRender) els.detail.scrollIntoView({ block: 'start' });
  }
  firstRender = false;
}

els.q.addEventListener('input', () => saveState({ q: els.q.value }));
els.cat.addEventListener('change', () => saveState({ cat: els.cat.value }));
els.chain.addEventListener('change', () => saveState({ chain: els.chain.value }));
els.sort.addEventListener('change', () => saveState({ sort: els.sort.value }));
els.watch.addEventListener('change', () => saveState({ watch: els.watch.checked }));
els.tbody.addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-slug]');
  if (tr) saveState({ p: tr.dataset.slug });
});
window.addEventListener('hashchange', render);
render();
