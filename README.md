# Haneul Oracle

Price oracle infrastructure for the Haneul network, built on [Pyth](https://pyth.network) price feeds delivered over the [Wormhole](https://wormhole.com) guardian network.

This is a community deployment. It is not operated or endorsed by the Pyth Data Association or the Wormhole Foundation. The on-chain contracts verify the same guardian signatures as every official Pyth deployment; trust assumptions are identical.

## How it works

Pyth is a pull oracle. Publishers (exchanges and trading firms) sign prices, the Wormhole guardian network (13 of 19 signatures) attests them into VAAs, and the signed payloads are served from the public [Hermes](https://hermes.pyth.network) API. Anyone can submit those payloads to any chain; the receiving contract verifies the guardian signatures cryptographically. No permission is involved at any step.

```
Pyth publishers -> Wormhole guardians (13/19 sign) -> Hermes API
                                                        |
                                    relayer daemon (this repo)
                                                        |
                             wormhole package (verifies signatures)
                                                        |
                                 pyth package (price feed objects)
                                                        |
                              consumers (lending, stablecoin, ...)
```

## Repository layout

| Path | Description |
|---|---|
| `wormhole/` | Wormhole core bridge Move package (guardian signature verification) |
| `pyth/` | Pyth receiver Move package (price feed objects, staleness checks) |
| `relayer/` | TypeScript daemons: price relayer (Hermes to chain) and guardian set synchronizer |
| `scripts/` | Deployment and initialization tooling |

## Provenance

- `wormhole/` is ported from `wormhole-foundation/wormhole` (`sui/wormhole`, rev `c5a2eabe`), the exact revision the upstream Pyth contracts pin. Apache-2.0.
- `pyth/` is ported from `pyth-network/pyth-crosschain` (`target_chains/sui/contracts`). Apache-2.0.
- The port follows the same recipe Pyth itself used for its IOTA, Movement, and other community-chain deployments (see `target_chains/sui/vendor/` upstream).

Deviations from upstream are kept minimal and are documented per commit:

- Wormhole chain ID for Haneul: `8282` (matches the registered coin type).
- Package upgrades and configuration changes are authorized by an `AdminCap` held by the deployer instead of upstream governance VAAs, which can never target this chain ID.
- Guardian set updates remain VAA-driven and permissionless, exactly as upstream.

## Consumer guidance

Always guard against stale prices. Read a price only through the staleness-checked entry points and reject timestamps older than your application's tolerance (lending liquidations typically use 60 seconds or less).
