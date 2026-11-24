// Token launch radar: the model. One sealed DefiLlama snapshot in, one ranked board out.
//
// The board ranks every protocol that records no token yet and is not a wrapped, staked,
// bridged or versioned product of one that trades. The snapshot's watchlist (TVL at or above
// the house floor) is the floor of that set, never its ceiling: the same screen is applied at
// every TVL, so the board also carries the early protocols below the floor.
//
// Implied value comes only from the snapshot's own figures:
//
//   implied = tvl_usd x peer_multiple x growth_factor x maturity_factor
//
// peer_multiple prices a protocol the way the market already prices its tokenized peers: the
// median market-cap/TVL of the snapshot's tokenized protocols in the same category, shrunk
// toward the global median when a category has few peers. The peer ratios are winsorized to
// the pooled 10th-90th percentile band first: a token whose market cap prices something other
// than its protocol's TVL (an exchange token, a locker) is a broken comparable, and in a
// category with one or two peers it would otherwise be the whole multiple. growth_factor reads the seven-day
// TVL change, clamped so one wild week cannot carry a ranking. maturity_factor rewards a
// record that has run longer with no token: the longer a protocol has operated tokenless, the
// more of a launch its record supports. No protocol name is ever special-cased.

/** One protocol entry of the snapshot: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's stated constants. The dashboard prints them; nothing hides in the code. */
export const MODEL = {
  version: 'peer-multiple-1',
  growth_clamp_low: -50,
  growth_clamp_high: 100,
  growth_weight: 0.35,
  growth_floor: 0.65,
  maturity_base: 0.75,
  maturity_span: 0.25,
  maturity_full_years: 5,
  shrink_prior: 4,
  winsor_low_pct: 10,
  winsor_high_pct: 90,
};

/** Categories whose products are a claim on another protocol's asset, not a launch of their own. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A name ending in a version marker is one product line of a protocol, not the protocol itself. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of a token that already trades. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's product, not a launch to come. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** True when the snapshot records no token for the protocol: no CoinGecko id and no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** True when the protocol is a wrapped, staked, bridged or versioned product of another. */
export function isProductLine(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (PRODUCT_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix));
}

/** The board's universe: records no token, and is not a product of one that trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && !isProductLine(p);
}

/** Whole days between two YYYY-MM-DD dates, UTC. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** The age of a protocol's record in days at the snapshot date, or null when unreported. */
export function ageDays(snapshot: Snapshot, p: SnapshotProtocol): number | null {
  if (p.listed_at === null) return null;
  const days = daysBetween(p.listed_at, snapshot.as_of);
  return days >= 0 ? days : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A percentile of a sorted array, by linear interpolation between the nearest ranks. */
function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const at = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Peer multiples: how the market prices tokenized protocols against their TVL. */
export interface PeerMultiples {
  global_median: number;
  by_category: Map<string, { peers: number; median: number; multiple: number }>;
}

/**
 * Median market-cap/TVL for every category that has tokenized peers, plus the global median.
 * A category's multiple is its own median shrunk toward the global one with a prior weight of
 * MODEL.shrink_prior, so a category with two peers cannot price a board on two observations.
 */
export function peerMultiples(snapshot: Snapshot): PeerMultiples {
  const raw: { category: string | null; ratio: number }[] = [];
  for (const p of snapshot.protocols) {
    if (p.gecko_id === null || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    raw.push({ category: p.category, ratio: p.mcap_usd / p.tvl_usd });
  }
  const pooled = raw.map((r) => r.ratio).sort((a, b) => a - b);
  const bandLow = percentile(pooled, MODEL.winsor_low_pct);
  const bandHigh = percentile(pooled, MODEL.winsor_high_pct);
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const { category, ratio } of raw) {
    const winsorized = Math.min(bandHigh, Math.max(bandLow, ratio));
    all.push(winsorized);
    if (category !== null) {
      const list = ratiosByCategory.get(category) ?? [];
      list.push(winsorized);
      ratiosByCategory.set(category, list);
    }
  }
  const globalMedian = median(all);
  const byCategory = new Map<string, { peers: number; median: number; multiple: number }>();
  for (const [category, ratios] of ratiosByCategory) {
    const catMedian = median(ratios);
    const multiple =
      (ratios.length * catMedian + MODEL.shrink_prior * globalMedian) / (ratios.length + MODEL.shrink_prior);
    byCategory.set(category, { peers: ratios.length, median: catMedian, multiple });
  }
  return { global_median: globalMedian, by_category: byCategory };
}

/** The multiple applied to one protocol: its category's, or the global median when it has none. */
export function multipleFor(peers: PeerMultiples, p: SnapshotProtocol): { multiple: number; peers: number; category_median: number | null } {
  if (p.category !== null) {
    const entry = peers.by_category.get(p.category);
    if (entry !== undefined) return { multiple: entry.multiple, peers: entry.peers, category_median: entry.median };
  }
  return { multiple: peers.global_median, peers: 0, category_median: null };
}

/** The growth reading of one protocol: the clamped seven-day change, or null when unreported. */
export function growthPct(p: SnapshotProtocol): number | null {
  if (p.change_7d === null) return null;
  return Math.min(MODEL.growth_clamp_high, Math.max(MODEL.growth_clamp_low, p.change_7d));
}

/** The growth factor of one protocol. No reported change reads as no signal, factor 1. */
export function growthFactor(p: SnapshotProtocol): number {
  const g = growthPct(p);
  if (g === null) return 1;
  return Math.max(MODEL.growth_floor, 1 + (MODEL.growth_weight * g) / 100);
}

/** The maturity factor of one protocol, from the age of its record in days. */
export function maturityFactor(age: number): number {
  const years = age / 365.25;
  return MODEL.maturity_base + MODEL.maturity_span * Math.min(1, years / MODEL.maturity_full_years);
}

/** One protocol's implied value and the working that produced it. */
export interface Score {
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  growth_pct: number | null;
  growth_factor: number;
  age_days: number;
  maturity_factor: number;
}

/** The shared context a score needs: peer multiples and the fallback age for unreported listings. */
export interface ScoreContext {
  peers: PeerMultiples;
  fallback_age_days: number;
}

/** Build the scoring context for a snapshot: peer multiples and the rankable set's median age. */
export function scoreContext(snapshot: Snapshot): ScoreContext {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isRankable(p)) continue;
    const age = ageDays(snapshot, p);
    if (age !== null) ages.push(age);
  }
  return { peers: peerMultiples(snapshot), fallback_age_days: Math.round(median(ages)) };
}

/** Score one rankable protocol. The same function scores every row; no name is special-cased. */
export function score(snapshot: Snapshot, ctx: ScoreContext, p: SnapshotProtocol): Score {
  const { multiple, peers } = multipleFor(ctx.peers, p);
  const age = ageDays(snapshot, p) ?? ctx.fallback_age_days;
  const gFactor = growthFactor(p);
  const mFactor = maturityFactor(age);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * gFactor * mFactor));
  return {
    implied_value_usd: implied,
    peer_multiple: multiple,
    peer_count: peers,
    growth_pct: growthPct(p),
    growth_factor: gFactor,
    age_days: age,
    maturity_factor: mFactor,
  };
}

/** The category families the farm plans are written for. */
export type FarmFamily = 'lending' | 'trading' | 'yield' | 'rwa' | 'other';

export function farmFamily(p: SnapshotProtocol): FarmFamily {
  switch (p.category) {
    case 'Lending':
    case 'CDP':
      return 'lending';
    case 'Dexs':
    case 'Derivatives':
    case 'Options':
    case 'Perpetuals':
      return 'trading';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Farming':
    case 'Leveraged Farming':
      return 'yield';
    case 'RWA':
      return 'rwa';
    default:
      return 'other';
  }
}

/** A working position size for a protocol of this TVL, in whole dollars. */
export function positionUsd(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 500_000_000) return 10_000;
  if (p.tvl_usd >= 100_000_000) return 5_000;
  if (p.tvl_usd >= 25_000_000) return 2_500;
  if (p.tvl_usd >= 5_000_000) return 1_000;
  return 500;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/**
 * The farm plan for one protocol: five concrete steps, each with what it costs and how long it
 * takes. The steps are written from the protocol's own record: its first chain, its category
 * family and a position sized to its TVL. Nothing here names a web address or promises a
 * reward; where points are mentioned, the step says what activity would count if a programme
 * exists, because the snapshot records none.
 */
export function farmSteps(p: SnapshotProtocol, age: number): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const chainCount = p.chains.length;
  const stake = positionUsd(p);
  const gas = chain === 'Ethereum' ? '$15-40 in gas' : '$1-10 in gas';
  const weeks = age >= 730 ? 8 : 12;
  const family = farmFamily(p);
  const core: Record<FarmFamily, string> = {
    lending: `Supply ${money(stake)} of a major stablecoin or ETH as collateral in ${p.name} on ${chain}, then borrow a small amount (under 30% of the collateral value) and repay it within the week, so the address shows both sides of the market. Cost: ${gas} plus a few dollars of interest; about 25 minutes.`,
    trading: `Make ${money(stake)} of volume on ${p.name} on ${chain} across at least four separate sessions in the first week, trading liquid pairs and closing each position the same day, so the address reads as a genuine user rather than one wash trade. Cost: ${gas} plus roughly 0.1% in trading fees; about 20 minutes a session.`,
    yield: `Deposit ${money(stake)} into the main vault or curated market of ${p.name} on ${chain} and leave it in place; vault shares that accrue are the record of the position. Cost: ${gas} to deposit and the same again to withdraw later; about 15 minutes.`,
    rwa: `Complete the onboarding and any identity check ${p.name} asks of new users, then buy ${money(stake)} of its tokenized real-world asset product on ${chain} and hold it in the same wallet. Cost: ${gas} plus any issuance spread the product states; about 40 minutes including the checks.`,
    other: `Make the core deposit or stake of ${p.name} on ${chain} with ${money(stake)}, using the product's main market rather than a side pool, and keep the position open. Cost: ${gas} in and the same again out; about 20 minutes.`,
  };
  const second: Record<FarmFamily, string> = {
    lending: `Repeat a smaller supply-and-borrow cycle every week for ${weeks} weeks, varying the amounts, and vote in any governance poll the app opens to suppliers. Cost: ${gas} a week; about 10 minutes a week.`,
    trading: `Come back for one session a week for ${weeks} weeks, and try a second feature of ${p.name} (a limit order, a different market, or its second chain deployment) at least twice. Cost: ${gas} plus fees a session; about 20 minutes a week.`,
    yield: `Add a small top-up or rebalance between two of the protocol's vaults once a month, and claim and re-deposit any rewards it pays, so the address shows an ongoing allocation rather than a single deposit. Cost: ${gas} a month; about 10 minutes a month.`,
    rwa: `Add a second, smaller purchase in a later month and read the product's monthly report or attestation when it posts, keeping the holding across at least one full reporting cycle. Cost: ${gas} plus the spread on ${money(Math.round(stake / 4))}; about 15 minutes a month.`,
    other: `Use one further feature of ${p.name} each month (a second market, a referral-free direct action, or its deployment on another of its ${chainCount} chains) so the address is a user of the product, not a single transaction. Cost: ${gas} a month; about 15 minutes a month.`,
  };
  return [
    `Set up a fresh wallet for ${p.name} and fund it on ${chain}, the chain where the protocol holds most of its record${chainCount > 1 ? ` (it tracks ${chainCount} chains in all)` : ''}; bridge ${money(stake + 100)} so fees never strand the position. Cost: ${gas} plus bridge fees of a few dollars; about 20 minutes.`,
    core[family],
    second[family],
    `Keep the position and the activity running for at least ${weeks} weeks, checking in weekly that the position is healthy and the wallet still holds it; consistency over months is what separates a farmer from a snapshot-day visitor if a launch ever counts usage. Cost: no spend beyond gas already counted; about 5 minutes a week.`,
    `Keep your own records (dates, amounts, transaction hashes) in a note, and if ${p.name} opens a points programme, a governance forum or a launch registration, join it with this same wallet promptly: the steps above are the activity such programmes usually count. Cost: $0; about 15 minutes when it happens.`,
  ];
}

/** One row of the board: the gate's fields, plus the model's working for the dashboard. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number;
  peer_multiple: number;
  peer_count: number;
  growth_factor: number;
  maturity_factor: number;
  watchlist: boolean;
}

/** Build the ranked board for a snapshot: every rankable protocol, most valuable first. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const ctx = scoreContext(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, s: score(snapshot, ctx, p) }));
  scored.sort(
    (a, b) =>
      b.s.implied_value_usd - a.s.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : 1),
  );
  return scored.map(({ p, s }, i) => ({
    slug: p.slug,
    name: p.name,
    rank: i + 1,
    implied_value_usd: s.implied_value_usd,
    farm_steps: farmSteps(p, s.age_days),
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.age_days,
    peer_multiple: Number(s.peer_multiple.toFixed(4)),
    peer_count: s.peer_count,
    growth_factor: Number(s.growth_factor.toFixed(4)),
    maturity_factor: Number(s.maturity_factor.toFixed(4)),
    watchlist: watch.has(p.slug),
  }));
}

/** The dashboard's data: the board plus the universe counts and the model's statement. */
export interface DashboardData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  counts: { tracked: number; tokenized: number; products: number; ranked: number; watchlist: number };
  global_multiple: number;
  rows: BoardRow[];
}

export function buildDashboardData(snapshot: Snapshot, board: BoardRow[]): DashboardData {
  const ctx = scoreContext(snapshot);
  const tokenized = snapshot.protocols.filter((p) => !recordsNoToken(p)).length;
  const products = snapshot.protocols.filter((p) => recordsNoToken(p) && isProductLine(p)).length;
  return {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    counts: {
      tracked: snapshot.protocols.length,
      tokenized,
      products,
      ranked: board.length,
      watchlist: snapshot.watchlist.length,
    },
    global_multiple: Number(ctx.peers.global_median.toFixed(4)),
    rows: board,
  };
}

/** The data.js the dashboard loads: the same data main.ts writes to board.json, for the page. */
export function dataScript(data: DashboardData): string {
  return `window.TOKEN_RADAR = ${JSON.stringify(data)};\n`;
}

/** Parse and lightly validate a snapshot document. Throws on a shape the model cannot read. */
export function parseSnapshot(text: string): Snapshot {
  const doc = JSON.parse(text) as Snapshot;
  if (typeof doc.as_of !== 'string' || !Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new Error('snapshot: not the document the radar reads (as_of, protocols, watchlist)');
  }
  return doc;
}

/**
 * Self-check a board against the gate's board rules, in the gate's own terms. Returns the
 * first problem found, or null when the board is one the gate accepts.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `rows: ${board.length}, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of board) {
    if (!known.has(row.slug)) return `slug not in the snapshot: ${row.slug}`;
    if (seen.has(row.slug)) return `slug twice: ${row.slug}`;
    seen.add(row.slug);
    if (row.name.trim() === '') return `empty name: ${row.slug}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000)
      return `implied value out of range: ${row.slug}`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `farm steps count: ${row.slug}`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `farm step of ${len} chars: ${row.slug}`;
    }
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `ranks are not exactly 1..N at ${i + 1}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd)
      return `implied value rises at rank ${i + 1}`;
  }
  if (board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'all implied values equal';
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug missing: ${slug}`;
  return null;
}
