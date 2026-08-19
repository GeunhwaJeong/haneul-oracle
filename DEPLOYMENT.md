# Deployment runbook

The full flow was rehearsed end to end on a disposable localnet on
2026-08-19: live guardian set 7 VAAs from Hermes verified on chain, BTC/USD
and ETH/USD feeds created and updated, admin configuration change applied.
The steps below reproduce that flow on any Haneul network.

## Prerequisites

- `haneul` CLI (v1.7.0 or later) and Node.js
- A funded deployer wallet. The AdminCaps, UpgradeCaps, and DeployerCaps go
  to the publishing address; the relayer can use a separate low-value wallet
  funded with gas only (its role is permissionless).
- `cd relayer && npm install`

Environment used by every script below:

```sh
export RPC_URL=<json-rpc url>              # e.g. http://127.0.0.1:9000
export RELAYER_KEY=<haneulprivkey1...>     # bech32 key of the signing wallet
```

## 1. Publish both packages

Localnet or any network where the manifests' `mainnet` environment does not
match the chain id (legacy-edition packages): use `test-publish`, which also
publishes the local wormhole dependency and records both addresses in a
`Pub.<env>.toml`:

```sh
cd pyth
haneul client test-publish --build-env mainnet \
  --publish-unpublished-deps --pubfile-path Pub.local.toml
```

Mainnet / SDK publish flow (avoids touching the operator's default client
config): publish `wormhole/` first via `node src/publish.mjs`, then write
`wormhole/Published.toml` with the resulting address so `pyth`'s local
dependency resolves, then build and publish `pyth/`:

```sh
# after publishing wormhole, record its address:
cat > wormhole/Published.toml <<EOF
[published.mainnet]
chain-id = "<chain id>"
published-at = "<wormhole package id>"
original-id = "<wormhole package id>"
version = 1
EOF
cd pyth && haneul move build --dump-bytecode-as-base64 --build-env mainnet > pyth.json
node ../relayer/src/publish.mjs --bytecode pyth.json
```

Publishing transfers to the sender, per package: `UpgradeCap`,
`setup::DeployerCap` (consumed by init), and `admin::AdminCap` (keep safe;
it authorizes upgrades and configuration changes).

## 2. Initialize wormhole

Bootstraps directly at the CURRENT guardian set (index and 19 keys fetched
live from Wormholescan). No historical VAA replay needed.

```sh
cd relayer
node src/init-wormhole.mjs \
  --package <wormhole package id> \
  --deployer-cap <wormhole DeployerCap id> \
  --upgrade-cap <wormhole UpgradeCap id>
# prints: wormhole State: 0x...
```

## 3. Initialize pyth

Stable Pyth configuration: 60s stale threshold, update fee 1, the three
Pythnet data sources. The governance data source is set to an unmatchable
value (emitter chain 0, zero address), so the AdminCap is the sole
authority; see the note in `src/init-pyth.mjs`.

```sh
node src/init-pyth.mjs \
  --package <pyth package id> \
  --deployer-cap <pyth DeployerCap id> \
  --upgrade-cap <pyth UpgradeCap id>
# prints: pyth State: 0x...
```

## 4. Run the relayer

```sh
export PYTH_STATE_ID=<pyth state> WORMHOLE_STATE_ID=<wormhole state>
node src/relayer.mjs --once   # first run creates the PriceInfoObjects
node src/relayer.mjs --once   # subsequent runs update prices
node src/relayer.mjs          # or run as a daemon (RELAY_INTERVAL_SECS)
```

Feeds default to BTC/USD and ETH/USD; override with `FEED_IDS` (comma
separated hex ids from https://pyth.network/developers/price-feed-ids).

## 5. Keep the guardian set in sync

```sh
node src/sync-guardian-sets.mjs         # daemon, checks every 6h
node src/sync-guardian-sets.mjs --once  # single check
```

Rotations halt price updates until the new set's upgrade VAA is submitted
(permissionless, no key needed); existing prices are never corrupted. The
daemon submits automatically from the embedded VAA chain or Wormholescan
discovery, and logs a CRITICAL line if it cannot find the VAA.

## Admin operations

The publisher holds one `AdminCap` per package. Examples (any PTB tool):

- `pyth::admin::set_update_fee(cap, state, fee)`
- `pyth::admin::set_stale_price_threshold(cap, state, secs)`
- `pyth::admin::set_data_sources(cap, state, chains, emitters)`
- `wormhole::admin::set_fee(cap, state, amount)`
- Upgrades: `admin::authorize_upgrade(cap, state, digest)` in the same PTB
  as the upgrade command, then `contract_upgrade::commit_upgrade` /
  `upgrade_contract::commit_upgrade` with the receipt, then a separate
  transaction calling `admin::migrate(cap, state)`.

## Consumer contract checklist

- Read prices only through staleness-checked entry points; reject
  timestamps older than the application's tolerance.
- The update fee is paid per feed per update by the submitter.
