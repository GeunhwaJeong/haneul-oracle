# Pyth Price Receiver (Haneul port)

This is the Pyth price feed receiver Move package ported to the Haneul
framework. It verifies Pyth price update messages (through the local
`wormhole` package) and maintains on-chain price feed objects.

Ported from `pyth-network/pyth-crosschain` (`target_chains/sui/contracts`),
Apache-2.0. The only deviations from upstream are the Haneul framework
references, the local `wormhole` dependency, and the local `admin` module. See
the repository root `README.md` and `DEPLOYMENT.md` for the full picture, and
https://pyth.network/developers/price-feed-ids for feed ids.

Build and test:

```sh
haneul move build --build-env mainnet
haneul move test --build-env mainnet
```
