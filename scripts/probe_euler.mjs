// Quick sizing probe for Euler Earn: how much *real* curated AUM exists, and
// who manages it. Converts raw totalAssets -> USD via DefiLlama free price API.
// Resolves manager = curator (if set) else owner (Euler Earn often leaves curator=0).

const CHAINS = {
  ethereum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn",
  base: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-base/latest/gn",
  arbitrum: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-arbitrum/latest/gn",
  unichain: "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-unichain/latest/gn",
};
const ZERO = "0x0000000000000000000000000000000000000000";

async function gql(ep, query) {
  const r = await fetch(ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// DefiLlama coin id prefix per chain
const LLAMA_CHAIN = { ethereum: "ethereum", base: "base", arbitrum: "arbitrum", unichain: "unichain" };

async function pricesFor(chain, addrs) {
  const ids = addrs.map((a) => `${LLAMA_CHAIN[chain]}:${a}`);
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await fetch(`https://coins.llama.fi/prices/current/${chunk.join(",")}`);
    const j = await r.json();
    for (const [k, v] of Object.entries(j.coins || {})) out[k.toLowerCase()] = v; // {price, decimals, symbol}
  }
  return out;
}

const rows = [];
for (const [chain, ep] of Object.entries(CHAINS)) {
  let vaults;
  try {
    const d = await gql(ep, `{ eulerEarnVaults(first: 1000, orderBy: totalAssets, orderDirection: desc) { id name curator owner asset totalAssets } }`);
    vaults = d.eulerEarnVaults.filter((v) => v.totalAssets && v.totalAssets !== "0");
  } catch (e) {
    console.error(`  ${chain}: subgraph error ${e.message.slice(0, 80)}`);
    continue;
  }
  const assets = [...new Set(vaults.map((v) => v.asset.toLowerCase()))];
  const prices = await pricesFor(chain, assets);
  for (const v of vaults) {
    const p = prices[`${LLAMA_CHAIN[chain]}:${v.asset.toLowerCase()}`];
    if (!p || !p.price) continue;
    const usd = (Number(v.totalAssets) / 10 ** p.decimals) * p.price;
    if (usd < 1000) continue;
    rows.push({
      chain, name: v.name,
      manager: v.curator !== ZERO ? v.curator : v.owner,
      managerRole: v.curator !== ZERO ? "curator" : "owner",
      asset: p.symbol, usd,
    });
  }
  console.log(`  ${chain}: ${vaults.length} non-empty Earn vaults, ${rows.filter(r=>r.chain===chain).length} priced`);
}

rows.sort((a, b) => b.usd - a.usd);
const total = rows.reduce((s, r) => s + r.usd, 0);
console.log(`\nEuler Earn curated AUM (priced): $${(total / 1e6).toFixed(1)}M across ${rows.length} vaults`);
console.log(`\nTop Euler Earn vaults:`);
for (const r of rows.slice(0, 15))
  console.log(`  ${r.name.slice(0,34).padEnd(34)} ${r.chain.padEnd(9)} ${r.asset.padEnd(8)} $${(r.usd/1e6).toFixed(2).padStart(7)}M  ${r.managerRole} ${r.manager.slice(0,10)}`);

// unique managers
const byMgr = {};
for (const r of rows) byMgr[r.manager] = (byMgr[r.manager] || 0) + r.usd;
console.log(`\nDistinct managers: ${Object.keys(byMgr).length}`);

import fs from "node:fs";
fs.writeFileSync(new URL("../data/euler_earn_probe.json", import.meta.url).pathname, JSON.stringify(rows, null, 2));
