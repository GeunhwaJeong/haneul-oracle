// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One-time pyth initialization: calls pyth::init_pyth with the stable
// (mainnet) Pyth deployment configuration, matching upstream's
// getDefaultDeploymentConfig("stable").
//
// Usage:
//   RELAYER_KEY=... node src/init-pyth.mjs \
//     --package <pyth-package-id> \
//     --deployer-cap <DeployerCap object id> \
//     --upgrade-cap <UpgradeCap object id>

import { bcs } from "@haneullabs/haneul/bcs";
import { Transaction } from "@haneullabs/haneul/transactions";

import { client, keypair } from "./config.mjs";

const STALE_PRICE_THRESHOLD_SECS = 60;
const BASE_UPDATE_FEE = 1;

// Governance data source is deliberately set to an unmatchable value (emitter
// chain 0, zero address) instead of Pyth's real governance emitter. This
// deployment's authority is the AdminCap, not Pyth governance. Wormhole VAAs
// always carry a real emitter chain (>= 1), so no VAA can ever satisfy
// pyth::governance::verify_vaa, which fully closes the upstream VAA governance
// path (it would otherwise let Pyth global governance, target chain 0, mutate
// this deployment's config). If Pyth governance is ever wanted, the admin can
// point it at the real source with pyth::admin::set_governance_data_source.
const GOVERNANCE_DATA_SOURCE = {
  chain: 0,
  emitter: "0000000000000000000000000000000000000000000000000000000000000000",
};

// Pythnet price attestation emitters accepted as data sources.
const DATA_SOURCES = [
  {
    chain: 1,
    emitter: "6bb14509a612f01fbbc4cffeebd4bbfb492a86df717ebe92eb6df432a3f00a25",
  },
  {
    chain: 26,
    emitter: "f8cd23c2ab91237730770bbea08d61005cdda0984348f3f6eecb559638c0bba0",
  },
  {
    chain: 26,
    emitter: "e101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
  },
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const hexBytes = (h) => [...Buffer.from(h, "hex")];

async function main() {
  const packageId = arg("package");
  const deployerCap = arg("deployer-cap");
  const upgradeCap = arg("upgrade-cap");

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pyth::init_pyth`,
    arguments: [
      tx.object(deployerCap),
      tx.object(upgradeCap),
      tx.pure.u64(STALE_PRICE_THRESHOLD_SECS),
      tx.pure.u64(GOVERNANCE_DATA_SOURCE.chain),
      tx.pure(
        bcs
          .vector(bcs.u8())
          .serialize(hexBytes(GOVERNANCE_DATA_SOURCE.emitter))
          .toBytes(),
      ),
      tx.pure(
        bcs
          .vector(bcs.u64())
          .serialize(DATA_SOURCES.map((d) => d.chain))
          .toBytes(),
      ),
      tx.pure(
        bcs
          .vector(bcs.vector(bcs.u8()))
          .serialize(DATA_SOURCES.map((d) => hexBytes(d.emitter)))
          .toBytes(),
      ),
      tx.pure.u64(BASE_UPDATE_FEE),
    ],
  });

  const provider = client();
  const result = await provider.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair(),
    options: { showEffects: true, showObjectChanges: true },
  });
  const status = result.effects?.status?.status;
  console.log(`digest: ${result.digest} (${status})`);
  if (status !== "success") {
    console.error(
      `init failed on chain: ${result.effects?.status?.error ?? status}`,
    );
    process.exit(1);
  }
  const shared = (result.objectChanges ?? []).find(
    (c) => c.type === "created" && c.objectType?.endsWith("::state::State"),
  );
  if (shared) console.log(`pyth State: ${shared.objectId}`);
}

await main();
