// Unified builder: merges Morpho curators + Euler Earn managers + Aave risk
// service providers into one dataset, and emits a Datum-SDK data global
// (window.CURATOR_DATA) for the dashboard.
//
// relationshipType:
//   "curator"      -> allocates depositor capital, earns perf fee (Morpho, Euler Earn)
//   "risk_manager" -> advises params under DAO contract, does NOT allocate (Aave), kept
//                     OUT of the curator AUM rankings; shown in its own section.

import fs from "node:fs";
const DIR = new URL("../data", import.meta.url).pathname;

// ---- shared asset-type classifier (same buckets as classify.mjs) ----
const RULES = [
  { b: "Pendle / Fixed-term", t: (s) => /^PT[-_]/i.test(s) },
  { b: "RWA / Credit", t: (s) => /(usual|USDtb|buidl|ustb|FalconX|midas|mF-|mBASIS|mHYPER|hgT|backed|bC3M|RWA|treasur|tbill|thBILL|EUTBL|USCC|XAU|SPYon|QQQon|SPXA|FLHYon|deSPX|AUSD|syrup|Maple)/i.test(s) },
  { b: "BTC", t: (s) => /BTC/i.test(s) },
  { b: "ETH / LST / LRT", t: (s) => /(ETH|stETH|weETH|rETH|ezETH|cbETH|osETH|OETH|mETH)/i.test(s) },
  { b: "Stablecoin", t: (s) => /(USD|USN|USDe|DAI|EUR|GHO|crvUSD|FRAX|sDAI|reUSD|deUSD|rlUSD|HLP|fxSAVE|PYUSD)/i.test(s) },
  { b: "Altcoin / L1", t: (s) => /(SOL|DOGE|ADA|LTC|XRP|AERO|POL|MATIC|MON|YFI|WELL|HYPE|KAT|MAMO|SPX)/i.test(s) },
];
const classify = (s) => (RULES.find((r) => r.t(s || "")) || { b: "Other / Long-tail" }).b;
const tier = (a) =>
  a >= 500e6 ? "Mega (>$500M)" : a >= 100e6 ? "Large ($100M–500M)" :
  a >= 25e6 ? "Mid ($25M–100M)" : a >= 5e6 ? "Small ($5M–25M)" : "Emerging (<$5M)";

const records = [];

// ---- 1. Morpho ----
const morpho = JSON.parse(fs.readFileSync(`${DIR}/curators_classified.json`, "utf8"));
for (const c of morpho) {
  records.push({
    name: c.name, protocol: "Morpho", relationshipType: "curator",
    morphoListed: c.morphoListed, address: c.address || null,
    aumUsd: c.aumUsd, vaultCount: c.vaultCount,
    chains: c.chains, byChain: c.byChain, byAssetType: c.byAssetType,
    dominantAssetType: c.dominantAssetType, assetProfile: c.assetProfile,
    ethShare: c.ethShare,
  });
}

// ---- 2. Euler Earn (group probe rows by manager brand) ----
const euler = JSON.parse(fs.readFileSync(`${DIR}/euler_earn_probe.json`, "utf8"));
// derive a manager brand from the vault name (Euler Earn often leaves curator=0)
function eulerBrand(name) {
  const n = name.replace(/\bEarn\b|\bEuler\b|\bvault\b|\bYield\b/gi, " ").trim();
  const m = n.match(/^([A-Za-z0-9]+(?:\s[A-Za-z0-9]+)?)/);
  let brand = (m ? m[1] : "Euler").trim();
  if (/^(USDC|USDT|WETH|WBTC|ETH|My|USDT0|RWAs?)$/i.test(brand) || brand.length < 2) brand = "Euler (native)";
  // normalize known casing / alias collisions to one canonical brand
  if (/^tid/i.test(brand)) brand = "TiD Capital";
  if (/^clearstar/i.test(brand)) brand = "Clearstar";
  return brand;
}
const eMap = new Map();
for (const r of euler) {
  const brand = eulerBrand(r.name);
  if (!eMap.has(brand)) eMap.set(brand, { name: brand, aumUsd: 0, vaultCount: 0, byChain: {}, byAssetType: {} });
  const e = eMap.get(brand);
  e.aumUsd += r.usd; e.vaultCount += 1;
  e.byChain[r.chain[0].toUpperCase() + r.chain.slice(1)] = (e.byChain[cap(r.chain)] || 0) + r.usd;
  const b = classify(r.asset);
  e.byAssetType[b] = (e.byAssetType[b] || 0) + r.usd;
}
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
for (const e of eMap.values()) {
  const sorted = Object.entries(e.byAssetType).sort((a, b) => b[1] - a[1]);
  const tot = sorted.reduce((s, [, v]) => s + v, 0) || 1;
  records.push({
    name: e.name, protocol: "Euler", relationshipType: "curator",
    morphoListed: false, address: null, aumUsd: e.aumUsd, vaultCount: e.vaultCount,
    chains: Object.keys(e.byChain), byChain: e.byChain, byAssetType: e.byAssetType,
    dominantAssetType: sorted[0]?.[0] ?? "Other / Long-tail",
    assetProfile: sorted.map(([b, v]) => `${b} ${Math.round(v / tot * 100)}%`).join(", "),
    ethShare: (e.byChain["Ethereum"] || 0) / (e.aumUsd || 1),
  });
}

// ---- 3. Aave risk service providers (manual, relationship = risk_manager) ----
// These firms set risk params for Aave's DAO-governed markets. They do NOT
// allocate depositor capital, so they are tracked separately and NOT summed
// into curator AUM. `overseesUsd` = approx Aave TVL under their risk mandate
// (advisory scope, not managed AUM). Anchored to live Aave TVL below.
let aaveTvl = null;
try {
  const r = await fetch("https://api.llama.fi/tvl/aave-v3");
  aaveTvl = await r.json();
} catch {}
const riskManagers = [
  { name: "Gauntlet", scope: "Risk params, caps, IR curves across Aave v3 markets" },
  { name: "Chaos Labs", scope: "Risk params, oracle & listing risk across Aave v3 markets" },
].map((m) => ({
  name: m.name, protocol: "Aave", relationshipType: "risk_manager",
  morphoListed: false, address: null, aumUsd: 0, overseesUsd: aaveTvl, scope: m.scope,
  govSource: "https://governance.aave.com",
  byAssetType: {}, byChain: {}, chains: [], dominantAssetType: "-",
  assetProfile: "advisory, not capital allocation",
}));
records.push(...riskManagers);

// ---- per-protocol curator records (one row per curator-protocol) ----
const perProtocol = records.filter((r) => r.relationshipType === "curator");

// ---- merge same-name curators across protocols into a single entity ----
// A curator like Clearstar or Hyperithm runs vaults on both Morpho and Euler;
// we combine into one row carrying total AUM plus a per-protocol breakdown.
const mergedMap = new Map();
for (const r of perProtocol) {
  if (!mergedMap.has(r.name)) {
    mergedMap.set(r.name, {
      name: r.name, relationshipType: "curator", morphoListed: false, address: null,
      aumUsd: 0, vaultCount: 0, byChain: {}, byAssetType: {}, protocols: [],
    });
  }
  const m = mergedMap.get(r.name);
  m.aumUsd += r.aumUsd;
  m.vaultCount += r.vaultCount || 0;
  m.morphoListed = m.morphoListed || r.morphoListed;
  if (!m.address && r.address) m.address = r.address;
  for (const [k, v] of Object.entries(r.byChain || {})) m.byChain[k] = (m.byChain[k] || 0) + v;
  for (const [k, v] of Object.entries(r.byAssetType || {})) m.byAssetType[k] = (m.byAssetType[k] || 0) + v;
  m.protocols.push({ protocol: r.protocol, aumUsd: r.aumUsd, vaultCount: r.vaultCount || 0 });
}

const curators = [...mergedMap.values()].map((c) => {
  const sorted = Object.entries(c.byAssetType).sort((a, b) => b[1] - a[1]);
  const tot = sorted.reduce((s, [, v]) => s + v, 0) || 1;
  c.protocols.sort((a, b) => b.aumUsd - a.aumUsd);
  return {
    ...c,
    chains: Object.keys(c.byChain),
    protocol: c.protocols.map((p) => p.protocol).join(" + "), // display summary
    dominantAssetType: sorted[0]?.[0] ?? "Other / Long-tail",
    assetProfile: sorted.map(([b, v]) => `${b} ${Math.round(v / tot * 100)}%`).join(", "),
    ethShare: (c.byChain["Ethereum"] || 0) / (c.aumUsd || 1),
    sizeTier: tier(c.aumUsd),
  };
}).sort((a, b) => b.aumUsd - a.aumUsd);

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const totalAum = sum(curators, (c) => c.aumUsd);

const byAssetType = {}, byChain = {}, byProtocol = {}, byTier = {};
for (const c of curators) {
  for (const [k, v] of Object.entries(c.byAssetType)) byAssetType[k] = (byAssetType[k] || 0) + v;
  for (const [k, v] of Object.entries(c.byChain)) byChain[k] = (byChain[k] || 0) + v;
  byTier[c.sizeTier] = (byTier[c.sizeTier] || 0) + c.aumUsd;
}
// per-protocol AUM split comes from the un-merged records (keeps Morpho/Euler distinct)
for (const r of perProtocol) byProtocol[r.protocol] = (byProtocol[r.protocol] || 0) + r.aumUsd;

const ASSET_COLORS = {
  "BTC": "var(--orange)", "ETH / LST / LRT": "var(--blue)", "Stablecoin": "var(--green)",
  "RWA / Credit": "var(--purple)", "Pendle / Fixed-term": "var(--yellow)",
  "Altcoin / L1": "var(--red)", "Other / Long-tail": "var(--fg-muted)",
};

const out = {
  meta: {
    generated: null, // stamped after the run (Date.now unavailable in workflow ctx, fine here)
    totalAumUsd: totalAum,
    curatorCount: curators.length,
    protocols: Object.keys(byProtocol),
    note: "Curator AUM = capital allocated via curated vaults (Morpho MetaMorpho + Euler Earn). Aave entries are risk service providers (advisory), excluded from AUM totals.",
  },
  curators,
  riskManagers,
  agg: { byAssetType, byChain, byProtocol, byTier },
  assetColors: ASSET_COLORS,
};

// stamp time without Date.now (use shell-provided env if present)
out.meta.generated = process.env.BUILD_TS || new Date().toISOString();

const js = `// AUTO-GENERATED by build.mjs, do not edit by hand.\nwindow.CURATOR_DATA = ${JSON.stringify(out, null, 2)};\n`;
fs.writeFileSync(new URL("../lending_curators.data.js", import.meta.url).pathname, js);
fs.writeFileSync(`${DIR}/unified.json`, JSON.stringify(out, null, 2));

// Cache-bust: stamp the data version onto the script src in index.html so a
// data change always yields a new URL (defeats browser/CDN caching of stale data).
const version = out.meta.generated.replace(/\D/g, "");
const htmlPath = new URL("../index.html", import.meta.url).pathname;
let html = fs.readFileSync(htmlPath, "utf8");
const newHtml = html.replace(
  /(<script src="lending_curators\.data\.js)(\?v=\d+)?(">)/,
  `$1?v=${version}$3`
);
if (newHtml !== html) fs.writeFileSync(htmlPath, newHtml);

console.log("Built unified dataset:");
console.log(`  Curators: ${curators.length} (Morpho + Euler), Risk managers: ${riskManagers.length} (Aave)`);
console.log(`  Total curator AUM: $${(totalAum / 1e6).toFixed(1)}M`);
console.log(`  By protocol: ${Object.entries(byProtocol).map(([k, v]) => `${k} $${(v/1e6).toFixed(0)}M`).join(", ")}`);
console.log(`  Aave TVL anchor (risk mgrs oversee): $${aaveTvl ? (aaveTvl/1e9).toFixed(1)+"B" : "n/a"}`);
console.log(`  Wrote lending_curators.data.js`);
