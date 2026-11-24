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
// category with one or two peers it would otherwise be the whole multiple. The dashboard also
// shows the peer set itself and an implied-value range: the same TVL and factors priced at
// the peer set's 25th and 75th percentile multiples, shrunk the same way, so a reader can see
// what the launch would be worth priced like a cheaper or a dearer peer. growth_factor reads the seven-day
// TVL change, clamped so one wild week cannot carry a ranking. maturity_factor rewards a
// record that has run longer with no token: the longer a protocol has operated tokenless, the
// more of a launch its record supports. No protocol name is ever special-cased.
//
// Each farm plan's steps carry their own cost and time as numbers, not just as prose: a chain's
// fee range and funding route have dollar figures behind their phrases, and a step that states
// a percentage fee states the volume it rides on. The dashboard sums those numbers into a plan
// total per row and rolls the board up by category, all from the same generated data. Each row
// also carries a short why-this-rank rationale — its standing in its category, its multiple
// against the category and global medians, its week, its record's age, and the ranks its peer
// range would give it — written by the same code from the same figures, for the detail view.

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
  version: 'peer-multiple-4',
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

/** One tokenized peer as the dashboard shows it: its name and figures, ratio winsorized. */
export interface PeerRef {
  slug: string;
  name: string;
  mcap_usd: number;
  tvl_usd: number;
  multiple: number;
}

/** One category's peer set: the median the model prices from, its quartiles and its members. */
export interface CategoryPeers {
  peers: number;
  median: number;
  multiple: number;
  p25: number;
  p75: number;
  list: PeerRef[];
}

/** Peer multiples: how the market prices tokenized protocols against their TVL. */
export interface PeerMultiples {
  global_median: number;
  global_p25: number;
  global_p75: number;
  by_category: Map<string, CategoryPeers>;
}

/**
 * Median market-cap/TVL for every category that has tokenized peers, plus the global median.
 * A category's multiple is its own median shrunk toward the global one with a prior weight of
 * MODEL.shrink_prior, so a category with two peers cannot price a board on two observations.
 * Each category also keeps its winsorized 25th and 75th percentile ratios and its member
 * list, so the dashboard can show the very set a multiple came from and price a range from
 * its spread; the point multiple's arithmetic is unchanged by keeping them.
 */
export function peerMultiples(snapshot: Snapshot): PeerMultiples {
  const raw: { category: string | null; ratio: number; slug: string; name: string; mcap: number; tvl: number }[] = [];
  for (const p of snapshot.protocols) {
    if (p.gecko_id === null || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    raw.push({ category: p.category, ratio: p.mcap_usd / p.tvl_usd, slug: p.slug, name: p.name, mcap: p.mcap_usd, tvl: p.tvl_usd });
  }
  const pooled = raw.map((r) => r.ratio).sort((a, b) => a - b);
  const bandLow = percentile(pooled, MODEL.winsor_low_pct);
  const bandHigh = percentile(pooled, MODEL.winsor_high_pct);
  const ratiosByCategory = new Map<string, number[]>();
  const refsByCategory = new Map<string, PeerRef[]>();
  const all: number[] = [];
  for (const item of raw) {
    const winsorized = Math.min(bandHigh, Math.max(bandLow, item.ratio));
    all.push(winsorized);
    if (item.category !== null) {
      const list = ratiosByCategory.get(item.category) ?? [];
      list.push(winsorized);
      ratiosByCategory.set(item.category, list);
      const refs = refsByCategory.get(item.category) ?? [];
      refs.push({
        slug: item.slug,
        name: item.name,
        mcap_usd: item.mcap,
        tvl_usd: item.tvl,
        multiple: Number(winsorized.toFixed(4)),
      });
      refsByCategory.set(item.category, refs);
    }
  }
  const globalMedian = median(all);
  const sortedAll = [...all].sort((a, b) => a - b);
  const byCategory = new Map<string, CategoryPeers>();
  for (const [category, ratios] of ratiosByCategory) {
    const catMedian = median(ratios);
    const multiple =
      (ratios.length * catMedian + MODEL.shrink_prior * globalMedian) / (ratios.length + MODEL.shrink_prior);
    const sorted = [...ratios].sort((a, b) => a - b);
    const list = (refsByCategory.get(category) ?? []).sort(
      (a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1),
    );
    byCategory.set(category, {
      peers: ratios.length,
      median: catMedian,
      multiple,
      p25: percentile(sorted, 25),
      p75: percentile(sorted, 75),
      list,
    });
  }
  return {
    global_median: globalMedian,
    global_p25: percentile(sortedAll, 25),
    global_p75: percentile(sortedAll, 75),
    by_category: byCategory,
  };
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

/**
 * The spread of one protocol's peer set, as two multiples: the category's winsorized 25th and
 * 75th percentile ratios, each shrunk toward the matching global quartile with the same prior
 * weight the point multiple is shrunk by, so a small peer set widens toward the global spread
 * instead of inventing one of its own. A category with no peers reads the global quartiles.
 */
export function multipleRange(peers: PeerMultiples, p: SnapshotProtocol): { low: number; high: number } {
  if (p.category !== null) {
    const entry = peers.by_category.get(p.category);
    if (entry !== undefined) {
      const n = entry.peers;
      return {
        low: (n * entry.p25 + MODEL.shrink_prior * peers.global_p25) / (n + MODEL.shrink_prior),
        high: (n * entry.p75 + MODEL.shrink_prior * peers.global_p75) / (n + MODEL.shrink_prior),
      };
    }
  }
  return { low: peers.global_p25, high: peers.global_p75 };
}

/** One protocol's implied-value range: its point score priced at its peer set's spread. */
export interface ValueRange {
  multiple_low: number;
  multiple_high: number;
  implied_low_usd: number;
  implied_high_usd: number;
}

/**
 * Price a scored protocol at the low and high ends of its peer set's spread, holding its own
 * TVL, growth factor and maturity factor. The range is presentational, never a second price:
 * it is clamped to contain the point estimate, and it never feeds the ranking.
 */
export function valueRange(ctx: ScoreContext, p: SnapshotProtocol, s: Score): ValueRange {
  const { low, high } = multipleRange(ctx.peers, p);
  const lo = Math.min(low, s.peer_multiple);
  const hi = Math.max(high, s.peer_multiple);
  return {
    multiple_low: lo,
    multiple_high: hi,
    implied_low_usd: Math.max(1, Math.round(p.tvl_usd * lo * s.growth_factor * s.maturity_factor)),
    implied_high_usd: Math.max(1, Math.round(p.tvl_usd * hi * s.growth_factor * s.maturity_factor)),
  };
}

/** The category families the farm plans are written for. */
export type FarmFamily =
  | 'lending'
  | 'cdp'
  | 'cdp-manager'
  | 'trading'
  | 'perps'
  | 'yield'
  | 'curator'
  | 'basis'
  | 'prediction'
  | 'rwa'
  | 'other';

export function farmFamily(p: SnapshotProtocol): FarmFamily {
  switch (p.category) {
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'Collateral Markets':
      return 'lending';
    case 'CDP':
      return 'cdp';
    case 'CDP Manager':
      return 'cdp-manager';
    case 'Dexs':
      return 'trading';
    case 'Derivatives':
    case 'Perpetuals':
    case 'Options':
    case 'Interest Rate Derivatives':
      return 'perps';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farming':
    case 'Farm':
    case 'Leveraged Farming':
      return 'yield';
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Liquidity Manager':
      return 'curator';
    case 'Basis Trading':
      return 'basis';
    case 'Prediction Market':
      return 'prediction';
    case 'RWA':
      return 'rwa';
    default:
      return 'other';
  }
}

/**
 * What it costs to work on one chain: the per-action fee phrase, the funding route phrase for
 * getting money there, and the fee buffer a wallet should carry on top of the position. The
 * figures are the ordinary published ranges for each chain (Ethereum mainnet gas against an
 * L2's cents, a Bitcoin confirmation hour against a Solana minute); a chain the table does not
 * name gets the middle-of-the-road default rather than a guess dressed as a fact.
 */
export interface ChainProfile {
  gas: string;
  fund: string;
  buffer: number;
  /** The per-action fee range in dollars behind the gas phrase; plan totals price an action at its midpoint. */
  gas_low: number;
  gas_high: number;
  /** What the funding route costs in dollars, behind the fund phrase. */
  fund_cost: number;
}

const L2_PROFILE: ChainProfile = {
  gas: 'under $1 in gas',
  fund: 'bridging from Ethereum costs a few dollars and lands in about 10 minutes',
  buffer: 25,
  gas_low: 0,
  gas_high: 1,
  fund_cost: 3,
};

const CHEAP_PROFILE: ChainProfile = {
  gas: 'a few cents in fees',
  fund: 'bridging in or an exchange withdrawal costs a few dollars and lands within about 15 minutes',
  buffer: 10,
  gas_low: 0.01,
  gas_high: 0.1,
  fund_cost: 3,
};

const CHAIN_PROFILES: Record<string, ChainProfile> = {
  Ethereum: {
    gas: '$15-40 in gas',
    fund: 'an exchange withdrawal or a bridge in costs roughly $10-25 and lands within about 15 minutes',
    buffer: 100,
    gas_low: 15,
    gas_high: 40,
    fund_cost: 17.5,
  },
  Arbitrum: L2_PROFILE,
  Base: L2_PROFILE,
  Optimism: L2_PROFILE,
  'zkSync Era': L2_PROFILE,
  Linea: L2_PROFILE,
  Mantle: L2_PROFILE,
  Unichain: L2_PROFILE,
  Ink: L2_PROFILE,
  Solana: {
    gas: 'a few cents in fees',
    fund: 'bridging or an exchange withdrawal costs about $1 and lands within a few minutes',
    buffer: 10,
    gas_low: 0.01,
    gas_high: 0.1,
    fund_cost: 1,
  },
  Binance: {
    gas: '$0.10-0.50 in gas',
    fund: 'an exchange withdrawal costs under $1 and lands within a few minutes',
    buffer: 10,
    gas_low: 0.1,
    gas_high: 0.5,
    fund_cost: 0.5,
  },
  Polygon: {
    gas: 'a few cents in gas',
    fund: 'bridging from Ethereum costs a few dollars and lands in about 10 minutes',
    buffer: 10,
    gas_low: 0.01,
    gas_high: 0.1,
    fund_cost: 3,
  },
  Avalanche: {
    gas: '$0.10-0.60 in gas',
    fund: 'bridging in costs a few dollars and lands within about 15 minutes',
    buffer: 25,
    gas_low: 0.1,
    gas_high: 0.6,
    fund_cost: 3,
  },
  Tron: {
    gas: '$1-3 in fees',
    fund: 'an exchange withdrawal costs about $1 and lands within a few minutes',
    buffer: 10,
    gas_low: 1,
    gas_high: 3,
    fund_cost: 1,
  },
  Bitcoin: {
    gas: 'a network fee of $1-5',
    fund: 'an exchange withdrawal lands after roughly an hour of confirmations',
    buffer: 25,
    gas_low: 1,
    gas_high: 5,
    fund_cost: 5,
  },
  'Hyperliquid L1': {
    gas: 'a few cents in fees',
    fund: 'bridging USDC in from Arbitrum costs under $1 and lands within a few minutes',
    buffer: 10,
    gas_low: 0.01,
    gas_high: 0.1,
    fund_cost: 0.5,
  },
  Sui: CHEAP_PROFILE,
  Aptos: CHEAP_PROFILE,
  Algorand: CHEAP_PROFILE,
  Stellar: {
    gas: 'a fraction of a cent in fees',
    fund: 'an exchange withdrawal costs a fraction of a cent and lands within a minute',
    buffer: 10,
    gas_low: 0,
    gas_high: 0.01,
    fund_cost: 0.01,
  },
  Ripple: {
    gas: 'a fraction of a cent in fees',
    fund: 'an exchange withdrawal costs a fraction of a cent and lands within a minute',
    buffer: 10,
    gas_low: 0,
    gas_high: 0.01,
    fund_cost: 0.01,
  },
  Stacks: {
    gas: '$0.10-1 in fees',
    fund: 'bridging in or an exchange withdrawal costs a few dollars and lands within about 15 minutes',
    buffer: 25,
    gas_low: 0.1,
    gas_high: 1,
    fund_cost: 3,
  },
};

/** The chain profile for a chain name from the snapshot, with the default for unnamed chains. */
export function chainProfile(chain: string): ChainProfile {
  return (
    CHAIN_PROFILES[chain] ?? {
      gas: '$1-5 in fees',
      fund: 'bridging in or an exchange withdrawal costs a few dollars and lands within about 15 minutes',
      buffer: 25,
      gas_low: 1,
      gas_high: 5,
      fund_cost: 3,
    }
  );
}

/** The midpoint of a chain's per-action fee range: what one action on that chain is priced at in a plan total. */
function gasMid(chain: string): number {
  const prof = chainProfile(chain);
  return (prof.gas_low + prof.gas_high) / 2;
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

/** An ordinal for prose: 1st, 2nd, 3rd, 4th … */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** How long a tokenless record runs, in prose: months under a year, else years to one decimal. */
function recordLength(age: number): string {
  const years = age / 365.25;
  if (years >= 1) return `${years.toFixed(1)} years`;
  return `${Math.max(1, Math.round(age / 30.44))} months`;
}

/**
 * The farm plan for one protocol: six concrete steps, each with what it costs and how long it
 * takes. The steps are written from the protocol's own record, not from a family template
 * alone: the setup names the chain the protocol's record starts on, the year that record runs
 * back to, and that chain's real funding route and fee range; the core action is written for
 * the protocol's own product type (a CDP mints, a curator's vault allocates, a basis strategy
 * hedges); a multi-chain protocol gets a step on its second named chain at that chain's fees,
 * and the running step answers the protocol's own seven-day TVL move in the snapshot, so a
 * growing record is farmed on a cadence and a shrinking one is not chased. Nothing here names
 * a web address or promises a reward; where points are mentioned, the step says what activity
 * would count if a programme exists, because the snapshot records none.
 */
/** One step of a farm plan: the text the board hands in, and the cost and time the step carries. */
export interface FarmStep {
  text: string;
  /**
   * Estimated dollars over the step's whole run: network fees at the midpoint of the chain's
   * fee range, the funding route's cost, and the percentage fees the step itself states, at
   * their midpoints. Spreads and funding a step mentions without a figure are not counted, and
   * the stake never is: it is capital, not a cost.
   */
  cost_usd: number;
  /** Estimated minutes over the step's whole run, recurring sessions included. */
  minutes: number;
}

/** How many weeks a plan runs: a record two years old or more is farmed on the shorter run. */
export function planWeeks(ageDays: number): number {
  return ageDays >= 730 ? 8 : 12;
}

export function farmPlan(p: SnapshotProtocol, age: number): FarmStep[] {
  const chain = p.chains[0] ?? 'its main chain';
  const secondChain = p.chains[1];
  const chainCount = p.chains.length;
  const stake = positionUsd(p);
  const prof = chainProfile(chain);
  const gas = prof.gas;
  const gm = gasMid(chain);
  const weeks = planWeeks(age);
  const months = Math.max(1, Math.round((weeks * 7) / 30.44));
  const family = farmFamily(p);
  const since = p.listed_at !== null ? `, where its record runs back to ${p.listed_at.slice(0, 4)}` : '';
  const core: Record<FarmFamily, FarmStep> = {
    lending: { text: `Supply ${money(stake)} of a major stablecoin, or another major asset its markets accept, as collateral in ${p.name} on ${chain}, then borrow a small amount (under 30% of the collateral value) and repay it within the week, so the address shows both sides of the lending market. Cost: ${gas} plus a few dollars of interest; about 25 minutes.`, cost_usd: gm + 3, minutes: 25 },
    cdp: { text: `Deposit ${money(stake)} of collateral in ${p.name} on ${chain} (a major asset it accepts, such as the chain's native token, BTC or ETH) and mint its stablecoin against it at a conservative ratio (collateral worth at least twice the debt), then repay part of the mint within the first month. Cost: ${gas} to open and adjust the position; about 25 minutes.`, cost_usd: 2 * gm, minutes: 25 },
    'cdp-manager': { text: `Deposit ${money(stake)} of collateral through ${p.name} on ${chain} (a major asset the vaults it manages accept, such as the chain's native token, BTC or ETH) and draw the vault's stablecoin against it at a conservative ratio (collateral worth at least twice the debt), then repay part of the draw within the first month. Cost: ${gas} to open and adjust the position; about 25 minutes.`, cost_usd: 2 * gm, minutes: 25 },
    trading: { text: `Trade ${money(stake)} of volume on ${p.name} on ${chain} across at least four separate sessions in the first week, and leave a small position in one of its main liquidity pools, so the address shows both swaps and provided liquidity. Cost: ${gas} plus roughly 0.1-0.3% in swap and pool fees; about 20 minutes a session.`, cost_usd: 5 * gm + 0.002 * stake, minutes: 80 },
    perps: { text: `Open and close small perpetual positions on ${p.name} on ${chain} across at least four separate sessions in the first week, keeping each position under ${money(Math.round(stake / 2))} of margin and closing it the same day, so the address reads as a genuine trader rather than one wash trade. Cost: ${gas} plus trading fees and any funding paid; about 20 minutes a session.`, cost_usd: 4 * gm, minutes: 80 },
    yield: { text: `Deposit ${money(stake)} into the main vault of ${p.name} on ${chain} and leave it in place; the vault shares that accrue are the record of the position. Cost: ${gas} to deposit and the same again to withdraw later; about 15 minutes.`, cost_usd: 2 * gm, minutes: 15 },
    curator: { text: `Deposit ${money(stake)} into a vault that ${p.name} curates on ${chain} (its vaults sit on lending markets and the curator sets their allocations), choosing the vault whose stated strategy is plain lending rather than looping. Cost: ${gas} to deposit and the same again to withdraw later; about 15 minutes.`, cost_usd: 2 * gm, minutes: 15 },
    basis: { text: `Deposit ${money(stake)} of stablecoins into the basis strategy of ${p.name} on ${chain} and hold the position; the strategy's own hedging is what the deposit funds, so no second leg is needed from this wallet. Cost: ${gas} to deposit and the same again to exit; about 15 minutes.`, cost_usd: 2 * gm, minutes: 15 },
    prediction: { text: `Place small trades on the most liquid markets of ${p.name} on ${chain}, about ${money(Math.round(stake / 10))} a market across at least ten markets in the first two weeks, and let some positions settle rather than selling every one early. Cost: ${gas} plus the spreads paid; about 15 minutes a session.`, cost_usd: 10 * gm, minutes: 60 },
    rwa: { text: `Complete the onboarding and any identity check ${p.name} asks of new users, then buy ${money(stake)} of its tokenized real-world asset product on ${chain} and hold it in the same wallet. Cost: ${gas} plus any issuance spread the product states; about 40 minutes including the checks.`, cost_usd: gm, minutes: 40 },
    other: { text: `Make the core deposit or stake of ${p.name} on ${chain} with ${money(stake)}, using the product's main market rather than a side pool, and keep the position open. Cost: ${gas} in and the same again out; about 20 minutes.`, cost_usd: 2 * gm, minutes: 20 },
  };
  const second: Record<FarmFamily, FarmStep> = {
    lending: { text: `Repeat a smaller supply-and-borrow cycle every week for ${weeks} weeks, varying the amounts, and vote in any governance poll the app opens to suppliers. Cost: ${gas} a week; about 10 minutes a week.`, cost_usd: gm * weeks, minutes: 10 * weeks },
    cdp: { text: `Adjust the position once a month (top the collateral up or repay a slice as prices move) so it stays live and safely collateralised across the whole ${weeks}-week run. Cost: ${gas} a month; about 10 minutes a month.`, cost_usd: gm * months, minutes: 10 * months },
    'cdp-manager': { text: `Adjust the position once a month (top the collateral up or repay a slice as prices move) so it stays live and safely collateralised across the whole ${weeks}-week run. Cost: ${gas} a month; about 10 minutes a month.`, cost_usd: gm * months, minutes: 10 * months },
    trading: { text: `Come back for one session a week for ${weeks} weeks, and use a second feature of ${p.name} (a limit order, a different pair, or a second pool) at least twice. Cost: ${gas} plus roughly 0.1% of the position in swap fees a session; about 20 minutes a week.`, cost_usd: (gm + 0.001 * stake) * weeks, minutes: 20 * weeks },
    perps: { text: `Come back for one session a week for ${weeks} weeks and try a second market of ${p.name} at least twice, keeping the same small size. Cost: ${gas} plus fees and funding a session; about 20 minutes a week.`, cost_usd: gm * weeks, minutes: 20 * weeks },
    yield: { text: `Add a small top-up or rebalance between two of the protocol's vaults once a month, and claim and re-deposit any rewards it pays, so the address shows an ongoing allocation rather than a single deposit. Cost: ${gas} a month; about 10 minutes a month.`, cost_usd: gm * months, minutes: 10 * months },
    curator: { text: `Once a month, move a slice of the position (about a quarter) into a second vault ${p.name} curates, or top the first one up, and read the curator's posted allocation notes when they appear. Cost: ${gas} a month; about 10 minutes a month.`, cost_usd: gm * months, minutes: 10 * months },
    basis: { text: `Top the position up by about a tenth once a month and check the strategy's reported funding rate when it posts, keeping the deposit in place across the whole ${weeks}-week run. Cost: ${gas} a month; about 10 minutes a month.`, cost_usd: gm * months, minutes: 10 * months },
    prediction: { text: `Trade one or two new markets a week for ${weeks} weeks, favouring markets that resolve within the month, so the record builds steadily instead of in one burst. Cost: ${gas} plus spreads a week; about 15 minutes a week.`, cost_usd: 2 * gm * weeks, minutes: 15 * weeks },
    rwa: { text: `Add a second, smaller purchase in a later month and read the product's monthly report or attestation when it posts, keeping the holding across at least one full reporting cycle. Cost: ${gas} plus the spread on ${money(Math.round(stake / 4))}; about 15 minutes a month.`, cost_usd: gm * months, minutes: 15 * months },
    other: { text: `Use one further feature of ${p.name} each month (a second market or a second product line, or its governance if it opens one) so the address is a user of the product, not a single transaction. Cost: ${gas} a month; about 15 minutes a month.`, cost_usd: gm * months, minutes: 15 * months },
  };
  // The same-chain deepen step is worded for the product type where the generic market-or-vault
  // wording would name the wrong thing: a prediction record deepens across more markets, not
  // pools, a perps record across another of its markets, not a vault, and an RWA record's
  // recurring step already makes a second purchase, so its deepen step reaches for a second
  // product instead of repeating the purchase.
  const deepenSingle: FarmStep =
    family === 'prediction'
      ? {
          text: `Deepen the same-chain record: run a second, smaller set of trades (about ${money(Math.round(stake / 4))} in total) across a different set of markets of ${p.name} on ${chain}, so the record is not riding on a single market. Cost: ${gas} a trade plus the spreads paid; about 15 minutes.`,
          cost_usd: 5 * gm,
          minutes: 15,
        }
      : family === 'perps'
        ? {
            text: `Deepen the same-chain record: run a second, smaller position (about ${money(Math.round(stake / 4))}) in a different market of ${p.name} on ${chain}, so the record is not riding on a single market. Cost: ${gas} in and the same again out; about 15 minutes.`,
            cost_usd: 2 * gm,
            minutes: 15,
          }
        : family === 'rwa'
        ? {
            text: `Deepen the same-chain record: if ${p.name} offers a second product on ${chain} (a different asset or a different maturity), buy a smaller amount (about ${money(Math.round(stake / 4))}) of that one too, so the record is not riding on a single product; if it offers only the one, add the same amount again in a later month instead. Cost: ${gas} plus any issuance spread the product states; about 15 minutes.`,
            cost_usd: gm,
            minutes: 15,
          }
        : {
            text: `Deepen the same-chain record: run a second, smaller position (about ${money(Math.round(stake / 4))}) in a different market or vault of ${p.name} on ${chain}, so the address is not riding on a single pool. Cost: ${gas} in and the same again out; about 15 minutes.`,
            cost_usd: 2 * gm,
            minutes: 15,
          };
  const deepen: FarmStep =
    secondChain !== undefined
      ? {
          text: `Repeat the core action at a smaller size (about ${money(Math.round(stake / 4))}) on ${secondChain}, the second deployment in ${p.name}'s record${chainCount > 2 ? ` of ${chainCount} chains` : ''}: there, ${chainProfile(secondChain).fund}, and each action costs ${chainProfile(secondChain).gas}. Cost: as stated; about 20 minutes to set up.`,
          cost_usd: chainProfile(secondChain).fund_cost + 2 * gasMid(secondChain),
          minutes: 20,
        }
      : deepenSingle;
  const g7 = p.change_7d;
  const trend =
    g7 !== null && g7 >= 5
      ? `the snapshot's last week had its TVL up ${Math.round(g7)}%, so keep the weekly cadence while it is growing rather than front-running it in one day`
      : g7 !== null && g7 <= -15
        ? `its TVL fell ${Math.round(-g7)}% in the snapshot's last week, so hold the planned size and do not add beyond it until the record steadies`
        : 'consistency over months is what separates a farmer from a snapshot-day visitor if a launch ever counts usage';
  return [
    {
      text: `Set up a fresh wallet for ${p.name} and fund it on ${chain}${since}; ${prof.fund}, so move ${money(stake + prof.buffer)} in to cover the position and its fees. Cost: the funding cost just stated; about 20 minutes.`,
      cost_usd: prof.fund_cost,
      minutes: 20,
    },
    core[family],
    second[family],
    deepen,
    {
      text: `Keep the position and the activity running for at least ${weeks} weeks, checking in weekly that the position is healthy and the wallet still holds it; ${trend}. Cost: no spend beyond the fees already counted; about 5 minutes a week.`,
      cost_usd: 0,
      minutes: 5 * weeks,
    },
    {
      text: `Keep your own records (dates, amounts, transaction hashes) in a note, and if ${p.name} opens a points programme, a governance forum or a launch registration, join it with this same wallet promptly: the steps above are the activity such programmes usually count. Cost: $0; about 15 minutes when it happens.`,
      cost_usd: 0,
      minutes: 15,
    },
  ];
}

/** The farm plan's step texts: what the board hands in, in the gate's shape. */
export function farmSteps(p: SnapshotProtocol, age: number): string[] {
  return farmPlan(p, age).map((s) => s.text);
}

/** One row's farm totals, keyed by slug in the dashboard data: the plan's own numbers, summed. */
export interface FarmTotals {
  cost_usd: number;
  minutes: number;
  weeks: number;
}

/**
 * Sum a plan's step costs and times into the totals the dashboard shows. The cost is rounded
 * to whole dollars and never reads below a dollar: even the cheapest chain's plan pays its
 * funding route and a handful of actions across the run.
 */
export function farmTotals(p: SnapshotProtocol, age: number): FarmTotals {
  let cost = 0;
  let minutes = 0;
  for (const s of farmPlan(p, age)) {
    cost += s.cost_usd;
    minutes += s.minutes;
  }
  return { cost_usd: Math.max(1, Math.round(cost)), minutes, weeks: planWeeks(age) };
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

/** One category's peer set as the dashboard's detail view shows it. */
export interface PeerSet {
  category: string;
  median: number;
  multiple: number;
  peers: PeerRef[];
}

/** One row's implied-value range, keyed by slug in the dashboard data. */
export interface RowRange {
  mlo: number;
  mhi: number;
  lo: number;
  hi: number;
}

/** One row's why-this-rank rationale: the full text for the detail view, and a compact line for the board. */
export interface RankRationale {
  why: string;
  line: string;
}

/**
 * Why one row sits at its rank, in two to four sentences and a compact line, from the
 * snapshot's figures alone: where the row stands in its own category (by value, and by the
 * TVL it holds), how its applied multiple reads against its category's peer median and the
 * global median, what its seven-day move and its record's age did to its factors, and which
 * ranks its peer range would give it. The same figures the page already prints, stated as
 * the reason for the rank; nothing here feeds back into the score.
 */
export function rankRationale(
  snapshot: Snapshot,
  board: BoardRow[],
  peers: PeerMultiples,
  p: SnapshotProtocol,
  row: BoardRow,
  range: RowRange,
): RankRationale {
  const sibs = board.filter((r) => r.category === row.category);
  const catRank = sibs.findIndex((r) => r.slug === row.slug) + 1;
  const tvlRank = [...sibs]
    .sort((a, b) => b.tvl_usd - a.tvl_usd || a.rank - b.rank)
    .findIndex((r) => r.slug === row.slug) + 1;
  const catTvl = sibs.reduce((sum, r) => sum + r.tvl_usd, 0);
  const catLabel = row.category ?? 'Uncategorised';
  const inPhrase = row.category !== null ? `in ${catLabel}` : `among the board's uncategorised rows`;
  const standing =
    sibs.length === 1
      ? `${row.name} is the only ${catLabel} row on the board, on ${money(row.tvl_usd)} of TVL.`
      : `${row.name} stands ${catRank} of ${sibs.length} ${inPhrase} by implied value, on ${
          tvlRank === 1
            ? `the category's largest TVL (${money(row.tvl_usd)} of the ${money(catTvl)} its rows hold together)`
            : `${money(row.tvl_usd)} of TVL, the category's ${ordinal(tvlRank)}-largest`
        }.`;
  const entry = row.category !== null ? peers.by_category.get(row.category) : undefined;
  const applied = row.peer_multiple.toFixed(2);
  const global = peers.global_median.toFixed(2);
  const multiple =
    entry !== undefined && row.peer_count > 0
      ? `Its applied multiple, ${applied}×, is its category's peer median (${entry.median.toFixed(2)}×) shrunk toward the global median (${global}×) over ${entry.peers} tokenized peer${entry.peers === 1 ? '' : 's'}.`
      : `Its category records no tokenized peer with a market cap in the snapshot, so it is priced at the global peer median, ${global}×.`;
  const c = p.change_7d;
  const growthClause =
    c === null
      ? `No seven-day TVL change is reported for it, so its growth factor is a neutral ${row.growth_factor.toFixed(2)}`
      : c > 0.05
        ? `Its TVL rose ${c.toFixed(1)}% in the snapshot's last week, a growth factor of ${row.growth_factor.toFixed(2)}`
        : c < -0.05
          ? `Its TVL fell ${(-c).toFixed(1)}% in the snapshot's last week, a growth factor of ${row.growth_factor.toFixed(2)}`
          : `Its TVL was near flat over the snapshot's last week (${c.toFixed(1)}%), a growth factor of ${row.growth_factor.toFixed(2)}`;
  const maturityClause =
    ageDays(snapshot, p) !== null
      ? `its tokenless record runs ${recordLength(row.age_days)}, earning a maturity factor of ${row.maturity_factor.toFixed(2)} on the model's 0.75–1.00 scale`
      : `its record carries no listing date, so its maturity factor of ${row.maturity_factor.toFixed(2)} is read at the ranked set's median age`;
  const rankAt = (v: number): number => 1 + board.reduce((n, r) => n + (r.implied_value_usd > v ? 1 : 0), 0);
  const rankHigh = rankAt(range.hi);
  const rankLow = rankAt(range.lo);
  const hasPeers = entry !== undefined && row.peer_count > 0;
  const rangeSentence =
    rankHigh === row.rank && rankLow === row.rank
      ? `${hasPeers ? 'Its peer range' : 'The global peer range it is priced from'} is narrow beside its neighbours: priced at either end of it, it would still sit at about this rank.`
      : `Priced at ${hasPeers ? "its peer set's" : "the global peer spread's"} 75th-percentile multiple it would be worth ${money(range.hi)}, about rank ${rankHigh}; at the 25th percentile, ${money(range.lo)}, about rank ${rankLow}.`;
  const line =
    entry !== undefined && row.peer_count > 0
      ? `#${catRank} of ${sibs.length} in ${catLabel} · ${applied}× vs ${global}× global`
      : `#${catRank} of ${sibs.length} in ${catLabel} · priced at the global median, ${global}×`;
  return { why: [standing, multiple, `${growthClause}; ${maturityClause}.`, rangeSentence].join(' '), line };
}

/** One category's roll-up over the board's rows, for the dashboard's category overview. */
export interface CategorySummary {
  category: string | null;
  ranked: number;
  watchlist: number;
  tvl_usd: number;
  implied_usd: number;
  median_multiple: number;
}

/** The dashboard's data: the board plus the universe counts and the model's statement. */
export interface DashboardData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  counts: { tracked: number; tokenized: number; products: number; ranked: number; watchlist: number };
  global_multiple: number;
  total_implied_usd: number;
  median_multiple: number;
  peer_sets: PeerSet[];
  ranges: Record<string, RowRange>;
  farm_totals: Record<string, FarmTotals>;
  rationales: Record<string, RankRationale>;
  categories: CategorySummary[];
  rows: BoardRow[];
}

export function buildDashboardData(snapshot: Snapshot, board: BoardRow[]): DashboardData {
  const ctx = scoreContext(snapshot);
  const tokenized = snapshot.protocols.filter((p) => !recordsNoToken(p)).length;
  const products = snapshot.protocols.filter((p) => recordsNoToken(p) && isProductLine(p)).length;
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const ranges: Record<string, RowRange> = {};
  for (const row of board) {
    const p = bySlug.get(row.slug)!;
    const vr = valueRange(ctx, p, score(snapshot, ctx, p));
    ranges[row.slug] = {
      mlo: Number(vr.multiple_low.toFixed(4)),
      mhi: Number(vr.multiple_high.toFixed(4)),
      lo: vr.implied_low_usd,
      hi: vr.implied_high_usd,
    };
  }
  const peerSets: PeerSet[] = [...ctx.peers.by_category.entries()]
    .map(([category, entry]) => ({
      category,
      median: Number(entry.median.toFixed(4)),
      multiple: Number(entry.multiple.toFixed(4)),
      peers: entry.list,
    }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));
  const farmTotalsBySlug: Record<string, FarmTotals> = {};
  for (const row of board) {
    farmTotalsBySlug[row.slug] = farmTotals(bySlug.get(row.slug)!, row.age_days);
  }
  const rationales: Record<string, RankRationale> = {};
  for (const row of board) {
    rationales[row.slug] = rankRationale(snapshot, board, ctx.peers, bySlug.get(row.slug)!, row, ranges[row.slug]!);
  }
  const rowsByCategory = new Map<string | null, BoardRow[]>();
  for (const row of board) {
    const list = rowsByCategory.get(row.category) ?? [];
    list.push(row);
    rowsByCategory.set(row.category, list);
  }
  const categories: CategorySummary[] = [...rowsByCategory.entries()]
    .map(([category, rs]) => ({
      category,
      ranked: rs.length,
      watchlist: rs.filter((r) => r.watchlist).length,
      tvl_usd: rs.reduce((sum, r) => sum + r.tvl_usd, 0),
      implied_usd: rs.reduce((sum, r) => sum + r.implied_value_usd, 0),
      median_multiple: Number(median(rs.map((r) => r.peer_multiple)).toFixed(4)),
    }))
    .sort((a, b) => b.implied_usd - a.implied_usd || String(a.category).localeCompare(String(b.category)));
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
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    median_multiple: Number(median(board.map((r) => r.peer_multiple)).toFixed(4)),
    peer_sets: peerSets,
    ranges,
    farm_totals: farmTotalsBySlug,
    rationales,
    categories,
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
