// Asset-type classification layer.
// Maps the 116 raw collateral symbols into ~6 editorial buckets, then re-profiles
// each curator by asset type. This is the part that is intentionally editorial —
// the rules live here so they're easy to audit and adjust.

import fs from "node:fs";

const DIR = new URL("../data", import.meta.url).pathname;

// Order matters: first matching rule wins. Rules are case-insensitive substring/regex.
const RULES = [
  // Pendle principal tokens & fixed-term — check BEFORE the underlying, since
  // a PT-USDe should land in "Pendle/Fixed-term", not "Stablecoin".
  { bucket: "Pendle / Fixed-term", test: (s) => /^PT[-_]/i.test(s) },
  // RWA / off-chain + on-chain private credit: tokenized treasuries, credit,
  // gold, equities, and institutional credit (Maple/syrup, FalconX).
  // Tokenized equities use the Ondo "...on" suffix (SPYon, QQQon) and the
  // de-/Superstate families; Midas issues mF-ONE/mBASIS/mHYPER; XAU* = gold.
  // syrupUSDC/syrupUSDT = Maple private credit (checked here before Stablecoin).
  { bucket: "RWA / Credit", test: (s) => /(usual|USDtb|buidl|ustb|FalconX|midas|mF-|mBASIS|mHYPER|hgT|backed|bC3M|RWA|treasur|tbill|thBILL|EUTBL|USCC|XAU|SPYon|QQQon|SPXA|FLHYon|deSPX|syrup|Maple)/i.test(s) },
  // BTC and BTC-LSTs/wrappers
  { bucket: "BTC", test: (s) => /(BTC)/i.test(s) },
  // ETH, LSTs, LRTs
  { bucket: "ETH / LST / LRT", test: (s) => /(ETH|stETH|weETH|rETH|ezETH|cbETH|osETH|OETH|mETH)/i.test(s) },
  // Yield-bearing & plain stablecoins
  { bucket: "Stablecoin", test: (s) => /(USD|USN|USDe|DAI|EUR|GHO|crvUSD|FRAX|sDAI|reUSD|deUSD|rlUSD|USDtb|HLP|fxSAVE)/i.test(s) },
  // Altcoin / L1 majors & app-chain ecosystems (SOL, XRP, DOGE, HYPE, etc.)
  { bucket: "Altcoin / L1", test: (s) => /(SOL|JitoSOL|cbDOGE|cbADA|cbLTC|cbXRP|AERO|WPOL|MaticX|MATIC|WMON|MON|YFI|WELL|HYPE|KAT|MAMO|SPX)/i.test(s) },
];

const OTHER = "Other / Long-tail";

function classify(symbol) {
  if (!symbol) return OTHER;
  for (const r of RULES) if (r.test(symbol)) return r.bucket;
  return OTHER;
}

// Size tiers for AUM categorization
function tier(aumUsd) {
  if (aumUsd >= 500e6) return "Mega (>$500M)";
  if (aumUsd >= 100e6) return "Large ($100M–500M)";
  if (aumUsd >= 25e6) return "Mid ($25M–100M)";
  if (aumUsd >= 5e6) return "Small ($5M–25M)";
  return "Emerging (<$5M)";
}

const curators = JSON.parse(fs.readFileSync(`${DIR}/morpho_curators.json`, "utf8"));

// Build a global symbol→bucket map for transparency/audit
const symbolMap = {};

const enriched = curators.map((c) => {
  const byType = {};
  for (const [sym, usd] of Object.entries(c.byCollateral)) {
    const b = classify(sym);
    symbolMap[sym] = b;
    byType[b] = (byType[b] || 0) + usd;
  }
  // dominant asset type + a one-line profile
  const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0) || 1;
  const dominant = sorted[0]?.[0] ?? OTHER;
  const profile = sorted
    .map(([b, v]) => `${b} ${Math.round((v / total) * 100)}%`)
    .join(", ");
  return {
    name: c.name,
    verified: c.verified,
    aumUsd: c.aumUsd,
    sizeTier: tier(c.aumUsd),
    vaultCount: c.vaultCount,
    chains: Object.keys(c.byChain),
    ethShare: (c.byChain["Ethereum"] || 0) / (c.aumUsd || 1),
    dominantAssetType: dominant,
    assetProfile: profile,
    byAssetType: byType,
    byChain: c.byChain,
    description: c.description,
  };
});

fs.writeFileSync(`${DIR}/curators_classified.json`, JSON.stringify(enriched, null, 2));
fs.writeFileSync(`${DIR}/symbol_buckets.json`, JSON.stringify(symbolMap, null, 2));

// Report
const tierTotals = {};
const typeTotals = {};
for (const c of enriched) {
  tierTotals[c.sizeTier] = (tierTotals[c.sizeTier] || 0) + 1;
  for (const [t, v] of Object.entries(c.byAssetType))
    typeTotals[t] = (typeTotals[t] || 0) + v;
}

console.log("=== Curators by size tier ===");
for (const t of ["Mega (>$500M)", "Large ($100M–500M)", "Mid ($25M–100M)", "Small ($5M–25M)", "Emerging (<$5M)"])
  console.log(`  ${t.padEnd(20)} ${tierTotals[t] || 0} curators`);

console.log("\n=== Total AUM by asset type ===");
const gt = Object.values(typeTotals).reduce((s, v) => s + v, 0);
for (const [t, v] of Object.entries(typeTotals).sort((a, b) => b[1] - a[1]))
  console.log(`  ${t.padEnd(22)} $${(v / 1e6).toFixed(1).padStart(8)}M  ${(v / gt * 100).toFixed(1)}%`);

console.log("\n=== Curator profiles (top 15 by AUM) ===");
for (const c of enriched.slice(0, 15))
  console.log(`  ${c.name.padEnd(22)} ${c.sizeTier.padEnd(20)} | ${c.assetProfile}`);

console.log(`\n  Unclassified ('Other') symbols:`);
const other = Object.entries(symbolMap).filter(([, b]) => b === OTHER).map(([s]) => s);
console.log("   " + (other.join(", ") || "(none)"));
