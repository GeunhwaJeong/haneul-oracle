# Wormhole Core Bridge (Haneul port)

This is the Wormhole core bridge Move package ported to the Haneul framework.
It verifies guardian-signed VAAs and is the dependency the `pyth` package uses
to authenticate Pyth price update messages.

Ported from `wormhole-foundation/wormhole` (`sui/wormhole`, rev `c5a2eabe`),
Apache-2.0. The only deviations from upstream are the Haneul framework
references, the Wormhole chain ID (`8282`), and the local `admin` module. See
the repository root `README.md` and `DEPLOYMENT.md` for the full picture.

Build and test:

```sh
haneul move build --build-env mainnet
haneul move test --build-env mainnet
```
