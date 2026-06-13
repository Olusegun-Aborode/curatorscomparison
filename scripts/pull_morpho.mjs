// Morpho curator puller
// Pulls all MetaMorpho vaults across all chains, rolls up to curator level.
// Outputs: data/morpho_vaults_raw.json + data/morpho_curators.json
//
// Each curator gets: total AUM, AUM-by-chain, AUM-by-collateral-asset, vault list.
// Collateral exposure is derived from each vault's market allocation (supplyAssetsUsd),
// which is what lets us bucket curators by *asset type* rather than just deposit token.

const ENDPOINT = "https://blue-api.morpho.org/graphql";
const PAGE = 100;
const MIN_VAULT_USD = 10_000; // drop dust / test vaults

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json.data;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

const VAULTS_QUERY = `
query Vaults($first: Int!, $skip: Int!) {
  vaults(first: $first, skip: $skip, orderBy: TotalAssetsUsd, orderDirection: Desc) {
    items {
      address
      name
      listed
      asset { symbol }
      chain { id network }
      state {
        totalAssetsUsd
        curators { name }
        allocation {
          supplyAssetsUsd
          market { collateralAsset { symbol } loanAsset { symbol } }
        }
      }
    }
  }
}`;

const CURATORS_QUERY = `
query Curators($first: Int!, $skip: Int!) {
  curators(first: $first, skip: $skip) {
    items {
      id name description verified image ownerOnly
      socials { type url }
      addresses { address chainId }
      state { aum }
    }
  }
}`;

async function pullAll(query, key) {
  let skip = 0;
  const out = [];
  for (;;) {
    const data = await gql(query, { first: PAGE, skip });
    const items = data[key].items;
    out.push(...items);
    process.stdout.write(`\r  ${key}: ${out.length}`);
    if (items.length < PAGE) break;
    skip += PAGE;
  }
  process.stdout.write("\n");
  return out;
}

function main() {
  return (async () => {
    console.log("Pulling Morpho curators (identity)...");
    const curatorEntities = await pullAll(CURATORS_QUERY, "curators");

    console.log("Pulling Morpho vaults (all chains)...");
    const vaultsRaw = await pullAll(VAULTS_QUERY, "vaults");

    // Keep real vaults with a named curator and meaningful TVL
    const vaults = vaultsRaw
      .filter((v) => v.state && v.state.totalAssetsUsd >= MIN_VAULT_USD)
      .filter((v) => (v.state.curators || []).length > 0)
      .map((v) => ({
        address: v.address,
        name: v.name,
        listed: v.listed,
        depositAsset: v.asset?.symbol ?? null,
        chainId: v.chain?.id ?? null,
        chain: v.chain?.network ?? null,
        tvlUsd: v.state.totalAssetsUsd,
        curators: v.state.curators.map((c) => c.name),
        collateral: (v.state.allocation || [])
          .filter((a) => a.supplyAssetsUsd > 0 && a.market?.collateralAsset)
          .map((a) => ({
            asset: a.market.collateralAsset.symbol,
            usd: a.supplyAssetsUsd,
          })),
      }));

    // Roll up to curator level
    const byCurator = new Map();
    for (const v of vaults) {
      // Split a vault's TVL evenly across co-curators (rare, but happens)
      const share = v.tvlUsd / v.curators.length;
      for (const cname of v.curators) {
        if (!byCurator.has(cname)) {
          byCurator.set(cname, {
            name: cname,
            aumUsd: 0,
            vaultCount: 0,
            byChain: {},
            byCollateral: {},
            byDepositAsset: {},
            vaults: [],
          });
        }
        const c = byCurator.get(cname);
        c.aumUsd += share;
        c.vaultCount += 1;
        c.byChain[v.chain] = (c.byChain[v.chain] || 0) + share;
        c.byDepositAsset[v.depositAsset] =
          (c.byDepositAsset[v.depositAsset] || 0) + share;
        // distribute collateral exposure proportionally within this curator's share
        const collTotal = v.collateral.reduce((s, x) => s + x.usd, 0) || 1;
        for (const col of v.collateral) {
          const w = (col.usd / collTotal) * share;
          c.byCollateral[col.asset] = (c.byCollateral[col.asset] || 0) + w;
        }
        c.vaults.push({
          name: v.name,
          chain: v.chain,
          depositAsset: v.depositAsset,
          tvlUsd: v.tvlUsd,
        });
      }
    }

    // Attach identity metadata from the curators query (match by name)
    const entityByName = new Map(
      curatorEntities.map((e) => [e.name.toLowerCase(), e])
    );
    const curators = [...byCurator.values()]
      .map((c) => {
        const e = entityByName.get(c.name.toLowerCase());
        const addrs = e?.addresses ?? [];
        const mainnet = addrs.find((a) => a.chainId === 1) ?? addrs[0];
        return {
          ...c,
          morphoListed: e?.verified ?? false, // Morpho's own listing flag (NOT independent verification)
          address: mainnet?.address ?? null,  // on-chain curator-role controller (verifiable on Etherscan)
          addresses: addrs,
          description: e?.description ?? null,
          socials: e?.socials ?? [],
          reportedAum: e?.state?.aum ?? null,
        };
      })
      .sort((a, b) => b.aumUsd - a.aumUsd);

    const fs = await import("node:fs");
    const dir = new URL("../data", import.meta.url).pathname;
    fs.writeFileSync(`${dir}/morpho_vaults_raw.json`, JSON.stringify(vaults, null, 2));
    fs.writeFileSync(`${dir}/morpho_curators.json`, JSON.stringify(curators, null, 2));

    const totalAum = curators.reduce((s, c) => s + c.aumUsd, 0);
    console.log(`\nDone.`);
    console.log(`  Vaults kept: ${vaults.length}`);
    console.log(`  Curators:    ${curators.length}`);
    console.log(`  Total AUM:   $${(totalAum / 1e9).toFixed(2)}B`);
    console.log(`\n  Top 15 curators by AUM:`);
    for (const c of curators.slice(0, 15)) {
      const chains = Object.keys(c.byChain).length;
      console.log(
        `   ${c.name.padEnd(28)} $${(c.aumUsd / 1e6).toFixed(1).padStart(8)}M  ${String(c.vaultCount).padStart(3)} vaults  ${chains} chains${c.verified ? "  ✓" : ""}`
      );
    }
  })();
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
