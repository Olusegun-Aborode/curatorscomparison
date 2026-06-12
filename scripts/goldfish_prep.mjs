// GoldFish TVL-growth analysis — assembles 3 datasets into goldfish.data.js:
//  1. Holder-activation gap (GGBR backing vs DeFi TVL)   [GoldFish Dune figures]
//  2. Demand proof: tokenized-gold DeFi usage             [Morpho markets + CoinGecko]
//  3. Warm leads: RWA/gold-comfortable curators           [local morpho_curators.json]
// Charts-only dashboard consumes window.GOLDFISH_DATA.

import fs from "node:fs";
const here = (p) => new URL(p, import.meta.url).pathname;

async function gql(q) {
  const r = await fetch("https://blue-api.morpho.org/graphql", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
  });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data;
}

// ---------- 1. GoldFish / GGBR (from the Dune dashboard, dune.com/goldfishgold_main) ----------
const GGBR = {
  supply: 25_000_000,
  backingUsd: 104_211_250,   // Collateral Pledged (USD)
  price: 4.1720,
  marketCapUsd: 104_301_211,
  ionAuCollateralOz: 25_000,
  defiTvlUsd: 6_200_000,     // Goldfish TVL (USD) from TVL chart (~$6.2M)
  stakedUsd: 1_300_000,      // Cum_Staked GGB (~$1.3M)
  source: "dune.com/goldfishgold_main/goldfishgold-protocol-analysis",
};

// ---------- 2. Tokenized-gold market caps (CoinGecko, with fallback) ----------
let tokGold = { XAUt: 2576e6, PAXG: 1924e6, goldOz: 4208 }; // fallback = last observed
try {
  const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=pax-gold,tether-gold");
  const d = await r.json();
  const byS = Object.fromEntries(d.map((c) => [c.symbol.toUpperCase(), c]));
  if (byS.XAUT && byS.PAXG) tokGold = { XAUt: byS.XAUT.market_cap, PAXG: byS.PAXG.market_cap, goldOz: byS.PAXG.current_price };
} catch { /* keep fallback */ }
const tokGoldTotal = tokGold.XAUt + tokGold.PAXG;

// ---------- 2b. Gold-collateral DeFi markets on Morpho (utilization detail) ----------
const mk = (await gql(`{ markets(first: 1000, orderBy: SupplyAssetsUsd, orderDirection: Desc) {
  items { collateralAsset { symbol } loanAsset { symbol } chain { network }
    state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd utilization } } } }`)).markets.items;

const goldMarkets = mk
  .filter((m) => m.collateralAsset && /XAU|PAXG|gold/i.test(m.collateralAsset.symbol || ""))
  .map((m) => ({
    market: `${m.collateralAsset.symbol}/${m.loanAsset?.symbol ?? "?"}`,
    collateral: m.collateralAsset.symbol, chain: m.chain.network,
    supplyUsd: m.state.supplyAssetsUsd || 0, borrowUsd: m.state.borrowAssetsUsd || 0,
    collateralUsd: m.state.collateralAssetsUsd || 0, util: (m.state.utilization || 0) * 100,
  }))
  // exclude data ghosts: a real overcollateralized market has collateral exceeding
  // its borrows; if collateralUsd << borrowUsd it's a glitch (PAXG/USDC $1.2B / $0 coll).
  .map((m) => ({ ...m, ghost: m.borrowUsd > 1e6 && m.collateralUsd < m.borrowUsd * 0.5 }))
  .sort((a, b) => b.supplyUsd - a.supplyUsd);
const realGold = goldMarkets.filter((m) => !m.ghost);
const realGoldSupply = realGold.reduce((s, m) => s + m.supplyUsd, 0);
const realGoldBorrow = realGold.reduce((s, m) => s + m.borrowUsd, 0);

// ---------- 2c. CROSS-PROTOCOL: tokenized gold posted as DeFi collateral ----------
// Aave is the biggest gold venue, not Morpho. Euler lists no gold. Source: DefiLlama yields.
const LEND = ["aave", "euler", "morpho", "compound", "fluid", "spark", "sky", "maker", "radiant", "silo"];
const norm = (p) => p.startsWith("aave") ? "Aave" : p.startsWith("fluid") ? "Fluid"
  : p.startsWith("morpho") ? "Morpho" : p.startsWith("compound") ? "Compound"
  : p.startsWith("euler") ? "Euler" : p.startsWith("spark") ? "Spark" : p.replace(/-.*/, "");
let goldPools = [];
try {
  const yd = (await (await fetch("https://yields.llama.fi/pools")).json()).data;
  goldPools = yd
    .filter((p) => /XAU|PAXG|GOLD/i.test(p.symbol || "") && LEND.some((x) => (p.project || "").startsWith(x)))
    .map((p) => ({ protocol: norm(p.project), symbol: p.symbol, chain: p.chain, tvlUsd: p.tvlUsd || 0 }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
} catch { /* fallback: morpho-only below */ }
const goldByProtocol = {};
for (const p of goldPools) goldByProtocol[p.protocol] = (goldByProtocol[p.protocol] || 0) + p.tvlUsd;
const goldCollateralTotal = goldPools.reduce((s, p) => s + p.tvlUsd, 0) || realGoldSupply;

// ---------- 2d. WHO CURATES gold? (vault-level: which fund supplies gold markets) ----------
// Honest check: the $62M gold collateral is borrower-POSTED into protocol/DAO markets.
// Almost none is supplied by a discretionary curator vault. Pull vault->gold allocations.
const vq = (await gql(`{ vaults(first: 1000, orderBy: TotalAssetsUsd, orderDirection: Desc) { items { name state { curators { name } allocation { supplyAssetsUsd supplyCapUsd enabled market { collateralAsset { symbol } loanAsset { symbol } } } } } } }`)).vaults.items;
const goldVaultByCurator = {};
let goldVaultSupplyTotal = 0;
// distinguish DEPLOYED (capital actually supplied) from ENABLED CAPACITY (caps a curator
// pre-approved). Steakhouse rated ~$45M of gold markets but deployed only dust — the
// curator is gold-READY; demand/deployment is the gap.
let goldCuratorCapacityUsd = 0, goldCuratorDeployedUsd = 0;
const goldEnabledMarkets = [];
for (const v of vq) {
  const st = v.state || {};
  const named = (st.curators || []).length;
  for (const a of (st.allocation || [])) {
    const sym = a.market?.collateralAsset?.symbol || "";
    if (!/XAU|PAXG|gold/i.test(sym)) continue;
    const who = named ? st.curators.map((c) => c.name).join("/") : "Direct / unregistered";
    if ((a.supplyAssetsUsd || 0) > 0) {
      goldVaultByCurator[who] = (goldVaultByCurator[who] || 0) + a.supplyAssetsUsd;
      goldVaultSupplyTotal += a.supplyAssetsUsd;
    }
    if (named && a.enabled) {
      goldCuratorCapacityUsd += a.supplyCapUsd || 0;
      goldCuratorDeployedUsd += a.supplyAssetsUsd || 0;
      goldEnabledMarkets.push({ curator: who, vault: v.name, market: `${sym}/${a.market?.loanAsset?.symbol ?? "?"}`, capUsd: a.supplyCapUsd || 0, deployedUsd: a.supplyAssetsUsd || 0 });
    }
  }
}
goldEnabledMarkets.sort((a, b) => b.capUsd - a.capUsd);
// group enabled capacity by curator (3 curators are gold-ready, not just Steakhouse)
const goldReadyMap = {};
for (const m of goldEnabledMarkets) {
  if (!goldReadyMap[m.curator]) goldReadyMap[m.curator] = { curator: m.curator, capUsd: 0, deployedUsd: 0, markets: 0 };
  goldReadyMap[m.curator].capUsd += m.capUsd; goldReadyMap[m.curator].deployedUsd += m.deployedUsd; goldReadyMap[m.curator].markets += 1;
}
const goldReadyCurators = Object.values(goldReadyMap).filter((c) => c.capUsd > 0).sort((a, b) => b.capUsd - a.capUsd);
const NAMED = new Set(cur0Names());
function cur0Names() { try { return JSON.parse(fs.readFileSync(here("../data/morpho_curators.json"), "utf8")).map((c) => c.name); } catch { return []; } }
const goldFundCuratedUsd = Object.entries(goldVaultByCurator)
  .filter(([k]) => NAMED.has(k)).reduce((s, [, v]) => s + v, 0);
const goldVaultCuration = Object.entries(goldVaultByCurator)
  .map(([curator, usd]) => ({ curator, usd, named: NAMED.has(curator) }))
  .sort((a, b) => b.usd - a.usd);

// venues where gold collateral SITS (borrower-posted) — governance, NOT fund-curation
const goldVenues = [
  { venue: "Aave v3 / v4", governance: "DAO-governed (risk: Gauntlet, Chaos Labs)", usd: goldByProtocol["Aave"] || 0 },
  { venue: "Morpho", governance: "Permissionless markets — borrower-posted", usd: goldByProtocol["Morpho"] || 0 },
  { venue: "Fluid", governance: "Protocol-governed", usd: goldByProtocol["Fluid"] || 0 },
  { venue: "Compound v3", governance: "Protocol-governed", usd: goldByProtocol["Compound"] || 0 },
].filter((m) => m.usd > 0).sort((a, b) => b.usd - a.usd);

// ---------- 3. Warm leads: curators with RWA / tokenized-gold collateral ----------
const cur = JSON.parse(fs.readFileSync(here("../data/morpho_curators.json"), "utf8"));
const goldRe = /XAU|PAXG|gold/i;
const rwaRe = /XAU|PAXG|buidl|ustb|usual|midas|mF-|mBASIS|mHYPER|thBILL|EUTBL|USCC|FalconX|treasur|tbill|SPYon|QQQon|backed|deSPX|FLHY/i;
const leads = cur.map((c) => {
  const rwa = Object.entries(c.byCollateral || {}).filter(([s]) => rwaRe.test(s));
  const gold = Object.entries(c.byCollateral || {}).filter(([s]) => goldRe.test(s));
  return {
    name: c.name, aumUsd: c.aumUsd, verified: c.verified,
    rwaUsd: rwa.reduce((s, [, v]) => s + v, 0),
    holds: rwa.map(([s]) => s),
    goldActive: gold.length > 0,
  };
}).filter((l) => l.rwaUsd > 0).sort((a, b) => b.rwaUsd - a.rwaUsd);

// ---------- 4. RWA PARTNERS for a GGBR/USDC vault ----------
// (a) RWA-comfortable Morpho curators who could RUN the vault — with contact data.
const social = (c, t) => (c.socials || []).find((s) => s.type === t)?.url || null;
const rwaCurators = cur.map((c) => {
  const rwa = Object.entries(c.byCollateral || {}).filter(([s]) => rwaRe.test(s));
  return {
    name: c.name, rwaUsd: rwa.reduce((s, [, v]) => s + v, 0), aumUsd: c.aumUsd, verified: c.verified,
    holds: rwa.map(([s]) => s), site: social(c, "url"), twitter: social(c, "twitter"), forum: social(c, "forum"),
  };
}).filter((c) => c.rwaUsd > 0).sort((a, b) => b.rwaUsd - a.rwaUsd);

// (b) CREDIT-TRANCHING protocols that could structure a GGBR senior/junior product.
// Metadata is curated; TVL + status are pulled LIVE from DefiLlama (research corrected:
// Goldfinch/TrueFi/Credix have wound down — flag them so outreach doesn't chase ghosts).
let llamaTvl = {};
try {
  const protos = await (await fetch("https://api.llama.fi/protocols")).json();
  for (const p of protos) llamaTvl[(p.name || "").toLowerCase()] = p.tvl || 0;
} catch { /* tvl stays unknown */ }
const tvlOf = (names) => { for (const n of names) { const v = llamaTvl[n.toLowerCase()]; if (v != null) return v; } return null; };
const statusOf = (tvl) => tvl == null ? "Untracked (new)" : tvl >= 100e6 ? "Active · large" : tvl >= 3e6 ? "Active" : tvl >= 0.5e6 ? "Winding down" : "Dormant";

const tranchers = [
  { name: "Centrifuge", chain: "Ethereum + multi", model: "DROP (senior) / TIN (junior)", focus: "Structured RWA credit; tokenized JH AAA CLO (JAAA)", fit: "High", site: "https://centrifuge.io", twitter: "https://x.com/centrifuge", note: "Best structured-finance tranching; already did JAAA", llama: ["Centrifuge Protocol", "Centrifuge"] },
  { name: "3jane", chain: "Ethereum", model: "USD3 (senior) / sUSD3 (leveraged)", focus: "Fintech/SMB credit; zkTLS underwriting", fit: "High", site: "https://3jane.xyz", twitter: "https://x.com/3janexyz", note: "Crypto-native tranching, Paradigm-backed — the thread", llama: ["3Jane Lending", "3Jane"] },
  { name: "Maple Finance", chain: "Ethereum, Solana, Arbitrum", model: "Pool-Delegate first-loss (junior buffer)", focus: "Institutional credit; syrupUSDC", fit: "Med-High", site: "https://maple.finance", twitter: "https://x.com/maplefinance", note: "Largest TVL but more permissioned / OC-leaning", llama: ["Maple"] },
  { name: "Clearpool", chain: "Ethereum + multi", model: "Pool first-loss elements", focus: "Permissioned institutional credit", fit: "Med", site: "https://clearpool.finance", twitter: "https://x.com/ClearpoolFin", note: "Unsecured lending to trading firms/fintechs", llama: ["Clearpool TPOOL", "Clearpool Lending", "Clearpool"] },
  { name: "Wildcat", chain: "Ethereum", model: "Configurable undercollateralized lines", focus: "Build-your-own credit vaults", fit: "Med", site: "https://wildcat.finance", twitter: "https://x.com/WildcatFi", note: "Highly configurable — flexible GGBR structuring", llama: ["Wildcat Protocol", "Wildcat"] },
  { name: "Qiro Finance", chain: "Aptos + Plume", model: "Senior / Junior (underwriter first-loss)", focus: "EM fintech/SME credit", fit: "Med", site: "https://qiro.fi", twitter: "https://x.com/QiroFinance", note: "Newer; tranche-level underwriting w/ skin-in-the-game", llama: ["Qiro", "Qiro Finance"] },
  { name: "Goldfinch", chain: "Ethereum", model: "Senior Pool / Backers (junior first-loss)", focus: "Uncollateralized biz / EM loans", fit: "Low", site: "https://goldfinch.finance", twitter: "https://x.com/goldfinch_fi", note: "Longest-running but TVL collapsed — largely wound down", llama: ["Goldfinch"] },
  { name: "TrueFi", chain: "Ethereum, Arbitrum", model: "Up to 3 tranches (Sr / Mezz / Jr)", focus: "Uncollateralized institutional", fit: "Low", site: "https://truefi.io", twitter: "https://x.com/TrueFiDAO", note: "Most flexible multi-tranche, but near-empty now", llama: ["TrueFi"] },
  { name: "Credix", chain: "Solana", model: "Deal-level tranching (up to 10)", focus: "EM private credit / receivables", fit: "Low", site: "https://credix.finance", twitter: "https://x.com/credixfinance", note: "Solana, institutional — but dormant", llama: ["Credix"] },
].map((t) => { const tvl = tvlOf(t.llama); return { ...t, tvlUsd: tvl, status: statusOf(tvl) }; })
 .sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));

// (c) RWA collateral ISSUERS (source the gold/credit collateral, not tranchers) — secondary.
const issuers = [
  { name: "Midas", what: "mF-ONE / mBASIS / mHYPER / mTBILL", site: "https://midas.app" },
  { name: "Superstate", what: "USTB / USCC", site: "https://superstate.co" },
  { name: "Ondo Finance", what: "USDY / SPYon / QQQon", site: "https://ondo.finance" },
];

// ---------- assemble ----------
const out = {
  meta: { generated: process.env.BUILD_TS || new Date().toISOString() },
  ggbr: GGBR,
  rwaPartners: { curators: rwaCurators, tranchers, issuers },
  activation: {
    backingUsd: GGBR.backingUsd, defiTvlUsd: GGBR.defiTvlUsd,
    dormantUsd: GGBR.backingUsd - GGBR.defiTvlUsd,
    activatedPct: GGBR.defiTvlUsd / GGBR.backingUsd * 100,
    tokGoldTotalUsd: tokGoldTotal, ggbrSharePct: GGBR.backingUsd / tokGoldTotal * 100,
  },
  demand: {
    tokGold, tokGoldTotalUsd: tokGoldTotal,
    // headline = tokenized gold posted as collateral across ALL lending protocols
    goldCollateralUsd: goldCollateralTotal,
    idleUsd: tokGoldTotal - goldCollateralTotal,
    categoryActivationPct: goldCollateralTotal / tokGoldTotal * 100,
    byProtocol: goldByProtocol,
    pools: goldPools,
    venues: goldVenues,
    venueCount: Object.keys(goldByProtocol).length,
    // honest curation finding: how much gold collateral is run by a discretionary fund vault
    vaultCuration: goldVaultCuration,
    vaultSupplyTotalUsd: goldVaultSupplyTotal,
    fundCuratedUsd: goldFundCuratedUsd,
    // curator readiness: caps pre-approved by named curators vs capital deployed
    curatorCapacityUsd: goldCuratorCapacityUsd,
    curatorDeployedUsd: goldCuratorDeployedUsd,
    enabledMarkets: goldEnabledMarkets,
    readyCurators: goldReadyCurators,
    // Morpho market-level detail (utilization story)
    morphoProductiveUsd: realGoldSupply, morphoBorrowUsd: realGoldBorrow,
    markets: goldMarkets,
  },
  leads,
};

fs.writeFileSync(here("../goldfish.data.js"),
  `// AUTO-GENERATED by goldfish_prep.mjs\nwindow.GOLDFISH_DATA = ${JSON.stringify(out, null, 2)};\n`);
fs.writeFileSync(here("../data/goldfish.json"), JSON.stringify(out, null, 2));

// version-stamp the goldfish.data.js reference in index.html (GoldFish pages live there)
try {
  const hp = here("../index.html"); let h = fs.readFileSync(hp, "utf8");
  const v = out.meta.generated.replace(/\D/g, "");
  const nh = h.replace(/(<script src="goldfish\.data\.js)(\?v=\d+)?(">)/, `$1?v=${v}$3`);
  if (nh !== h) fs.writeFileSync(hp, nh);
} catch { /* index.html not found */ }

console.log("GoldFish dataset built:");
console.log(`  1. Activation: backing $${(out.activation.backingUsd/1e6).toFixed(1)}M, DeFi TVL $${(out.activation.defiTvlUsd/1e6).toFixed(1)}M (${out.activation.activatedPct.toFixed(1)}% activated)`);
console.log(`  2. Demand (cross-protocol): tokenized gold $${(tokGoldTotal/1e9).toFixed(2)}B, gold-as-collateral $${(goldCollateralTotal/1e6).toFixed(1)}M (${out.demand.categoryActivationPct.toFixed(2)}% of category)`);
console.log(`     by protocol: ${Object.entries(goldByProtocol).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} $${(v/1e6).toFixed(1)}M`).join(", ")}`);
console.log(`     gold is borrower-posted; only $${(goldVaultSupplyTotal/1e3).toFixed(0)}K supplied via vaults ($${(goldFundCuratedUsd/1e3).toFixed(1)}K by named curators).`);
console.log(`     curator readiness: named curators ENABLED $${(goldCuratorCapacityUsd/1e6).toFixed(1)}M of gold caps but DEPLOYED only $${(goldCuratorDeployedUsd/1e3).toFixed(1)}K (gold-ready, demand-gated). ${goldEnabledMarkets.length} enabled markets.`);
console.log(`  3. Warm leads: ${leads.length} RWA-comfortable curators; gold-active: ${leads.filter(l=>l.goldActive).map(l=>l.name).join(", ")||"none"}`);
