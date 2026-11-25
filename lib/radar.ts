// Token Radar model (token-radar-01): a sealed DefiLlama snapshot in, a ranked board out.
//
// The board ranks pre-token protocols only. Live-token protocols are kept apart
// and shown at their market values, never mixed into the ranking.
//
// Value model — every factor comes from the snapshot's own figures, never from a
// list of names:
//
//   implied = TVL x categoryMultiple x momentum x seasoning x breadth
//
//   categoryMultiple  What a dollar of TVL is worth depends on what the protocol
//                     does with it: fee-earning books (perpetuals, lending, RWA)
//                     command a higher multiple than pass-through plumbing
//                     (bridges move value; they do not keep it). The table is
//                     keyed by DefiLlama category, the same for every protocol
//                     in that category.
//   momentum          1 + 0.45 x clamp(change_7d, -40, +100) / 100. A week's TVL
//                     move, damped and bounded, so one wild week (the snapshot
//                     holds a +4,448% outlier) cannot carry a protocol.
//   seasoning         0.45 + 0.55 x min(age_days, 1095) / 1095. A protocol that
//                     has run longer with no token has survived more cycles;
//                     a protocol with no listed_at is scored at 365 days.
//   breadth           1 + 0.04 x min(chains, 8). A footprint on more chains is
//                     worth a little more than the same TVL on one.
//
// implied is whole dollars, at least $1. Rows sort by implied value, then TVL,
// then slug, so the order is fully determined by the figures.
//
// The board covers the snapshot's whole watchlist (40 protocols) plus every
// other pre-token protocol below the watchlist floor that passes the watchlist's
// own exclusions (no bridge / liquid-staking / restaking / CEX category, no
// version-marked name, no wrapped or staked product). That is 138 early rows,
// 178 rows in all: the watchlist is the floor, never the ceiling.
//
// Farm plans are generated from each protocol's own record (category, main
// chain, TVL tier, age): six steps, each carrying what it costs and how long
// it takes. Nothing is hand-written per protocol.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';

/** FDV/TVL multiple by DefiLlama category. Revenue books sit above plumbing. */
export const CATEGORY_MULTIPLE: Record<string, number> = {
  Derivatives: 0.3,
  Lending: 0.28,
  RWA: 0.28,
  'Risk Curators': 0.26,
  'Onchain Capital Allocator': 0.26,
  Dexs: 0.25,
  CDP: 0.25,
  'Basis Trading': 0.24,
  Yield: 0.22,
  'Yield Aggregator': 0.22,
  'Liquidity Manager': 0.22,
  'Liquid Staking': 0.15,
  'Staking Pool': 0.15,
  Bridge: 0.12,
  'Canonical Bridge': 0.12,
};
export const DEFAULT_MULTIPLE = 0.2;

export const MODEL = {
  growthWeight: 0.45,
  growthFloor: -40,
  growthCap: 100,
  seasoningFloor: 0.45,
  seasoningRange: 0.55,
  seasoningDays: 1095,
  unknownAgeDays: 365,
  breadthPerChain: 0.04,
  breadthMaxChains: 8,
} as const;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Whole days from listed_at to the snapshot date; null when the date is missing. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** The watchlist's own exclusions, applied to early rows too: no wrapped or
 *  staked product, no version-marked pool, none of the excluded categories. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  const words = p.name.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/);
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) return false;
  return true;
}

export interface ModelFactors {
  categoryMultiple: number;
  momentum: number;
  growthPct: number;
  seasoning: number;
  breadth: number;
  ageDays: number | null;
}

/** The four factors and the implied value for one protocol. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string): { implied: number; factors: ModelFactors } {
  const categoryMultiple = p.category !== null && p.category in CATEGORY_MULTIPLE
    ? CATEGORY_MULTIPLE[p.category]!
    : DEFAULT_MULTIPLE;
  const growthPct = clamp(num(p.change_7d, 0), MODEL.growthFloor, MODEL.growthCap);
  const momentum = 1 + (MODEL.growthWeight * growthPct) / 100;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? MODEL.unknownAgeDays;
  const seasoning = MODEL.seasoningFloor +
    (MODEL.seasoningRange * Math.min(Math.max(ageForModel, 0), MODEL.seasoningDays)) / MODEL.seasoningDays;
  const breadth = 1 + MODEL.breadthPerChain * Math.min(p.chains.length, MODEL.breadthMaxChains);
  const implied = Math.max(1, Math.round(p.tvl_usd * categoryMultiple * momentum * seasoning * breadth));
  return { implied, factors: { categoryMultiple, momentum, growthPct, seasoning, breadth, ageDays: age } };
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  on_watchlist: boolean;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    momentum: number;
    seasoning: number;
    breadth: number;
  };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Position size from the protocol's own TVL: bigger books take bigger tickets. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

/** Minimum hold, from the protocol's age: younger books need a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The one action that fits the protocol's category, in plain words. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Lend $${capital} of USDC on ${name} (${chain}) and leave the loan open.`;
  if (c.includes('dex') || c.includes('liquidity')) return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and hold the LP position.`;
  if (c.includes('deriv') || c.includes('perp')) return `Post $${capital} of USDC as margin on ${name} (${chain}) and open one small hedged trade.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset on ${name} (${chain}) and hold it.`;
  if (c.includes('stak')) return `Stake $${capital} through ${name} on ${chain} and keep the staking receipt.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} with ${name}, then use the funds inside its app.`;
  if (c.includes('predict')) return `Fund $${capital} on ${name} and take one position in an open market.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One step as a single string: action, cost, time. Kept inside 20..600 chars. */
function stepText(s: string): string {
  let out = s.length > 600 ? `${s.slice(0, 596)}...` : s;
  if (out.length < 20) out += ' Keep the position open and check the protocol page weekly.';
  return out;
}

/** Six concrete farm steps, derived from the protocol's own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    stepText(`Set up a fresh wallet holding only the $${capital} you plan to farm, and store its seed phrase offline, never in a screenshot or chat. Cost: no fee to create the wallet. Time: 5 minutes.`),
    stepText(`${actionFor(p, capital, chain)} Cost: $${capital} of capital plus about $${gas} of gas. Time: 15 minutes to set up.`),
    stepText(`Do one qualifying action every week on ${chain} — a deposit, a swap, a vote, or a claim — so the wallet shows steady use rather than a single burst. Cost: about $2 of gas a week. Time: 10 minutes a week.`),
    stepText(`Hold the position for at least ${hold} days so the activity spans more than one snapshot of the protocol's users. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`),
    stepText(`Check ${p.name}'s own points or rewards page before you withdraw, and claim only through the link that page itself publishes. Cost: nothing to check; never pay a fee to claim. Time: 10 minutes.`),
    stepText(`Log the wallet address, the dates, and every transaction hash, then unwind in the reverse order you entered so nothing is left staked by accident. Cost: nothing but the log. Time: 5 minutes to write up, 15 minutes to unwind.`),
  ];
}

/** The ranked board: the whole watchlist plus every other launch candidate below
 *  the floor, scored and ordered by implied value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isLaunchCandidate(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...scoreProtocol(p, snapshot.as_of) }));
  scored.sort((a, b) =>
    b.implied - a.implied ||
    b.p.tvl_usd - a.p.tvl_usd ||
    (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    on_watchlist: snapshot.watchlist.includes(s.p.slug),
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.factors.ageDays,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.factors.categoryMultiple,
      growth_pct: s.factors.growthPct,
      momentum: Math.round(s.factors.momentum * 1e4) / 1e4,
      seasoning: Math.round(s.factors.seasoning * 1e4) / 1e4,
      breadth: Math.round(s.factors.breadth * 1e4) / 1e4,
    },
    farm_steps: farmSteps(s.p, s.factors.ageDays),
  }));
}

/** Live-token protocols by market cap, for the dashboard's separate Live view. */
export function liveRows(snapshot: Snapshot, count = 24): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, count)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  return {
    board,
    radar: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      model_version: MODEL_VERSION,
      watchlist_size: snapshot.watchlist.length,
      board_size: board.length,
      early_size: early,
      live_size: live.length,
      rows: board,
      live,
    },
  };
}

/** The snapshot out of a file's text, refused unless it is the shape scored. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not in the snapshot`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!r.name) return `${r.slug} has no name`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
