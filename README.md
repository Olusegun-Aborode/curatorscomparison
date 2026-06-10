# Lending Curators — Comparison Dashboard

A live dashboard of the asset managers (**"curators"**) who allocate depositor capital on
permissionless crypto lending protocols, categorized by **AUM size tier** and **collateral
asset type**. Ethereum-first, all chains.

Vanilla HTML + React (via CDN, no build step) — `index.html` is the whole app.

## Pages

- **Overview** — KPIs, an AUM treemap (colored by dominant asset type), asset-type & chain
  donuts, and a size-tier × asset-type breakdown.
- **Curators** — sortable / filterable table (protocol · asset type · size tier), an
  Ethereum-first AUM toggle, and a separate section for Aave risk service providers.
- **Methodology** — every data source and classification rule.

## Data model

`relationshipType` separates **curators** (allocate capital, earn a performance fee — Morpho,
Euler) from **risk managers** (advise DAO-governed markets but don't allocate — Gauntlet /
Chaos Labs on Aave). Risk managers are shown separately and excluded from AUM rankings.

## Sources & pipeline

| Step | Script | Source |
|---|---|---|
| 1 | `scripts/pull_morpho.mjs` | Morpho `blue-api.morpho.org` GraphQL — curators + all vaults |
| 2 | `scripts/classify.mjs` | Collateral symbols → 6 asset buckets + AUM size tiers |
| 3 | `scripts/probe_euler.mjs` | Euler v2 Goldsky subgraphs, priced via DefiLlama coins API |
| 4 | `scripts/build.mjs` | Merge → `lending_curators.data.js` (`window.CURATOR_DATA`) |

Regenerate the data (Node ≥ 18):

```bash
cd scripts
node pull_morpho.mjs && node classify.mjs && node probe_euler.mjs && node build.mjs
```

Raw + intermediate artifacts land in `data/`. This is a **snapshot**, not live-streaming —
re-run the pipeline to refresh.

## Current snapshot

~$2.24B curated AUM across 29 curators; **BTC collateral dominant (~64%)**; concentrated in
Steakhouse + Gauntlet on Morpho. Euler Earn is nascent (~$13M); Aave has no capital-allocating
curators (only risk advisors).

## Run locally

```bash
python3 -m http.server 4178
# open http://localhost:4178/
```

Deployed on Vercel as a static site (zero-config).
