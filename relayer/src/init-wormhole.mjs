// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One-time wormhole initialization: calls setup::complete with the CURRENT
// mainnet guardian set fetched from Wormholescan, bootstrapping directly at
// the live index instead of replaying historical guardian set upgrades.
//
// Usage:
//   RELAYER_KEY=... node src/init-wormhole.mjs \
//     --package <wormhole-package-id> \
//     --deployer-cap <DeployerCap object id> \
//     --upgrade-cap <UpgradeCap object id>

import { bcs } from "@haneullabs/haneul/bcs";
import { Transaction } from "@haneullabs/haneul/transactions";

import { WORMHOLESCAN_URL, client, keypair } from "./config.mjs";

// Guardian sets are kept alive for 24 hours after being replaced, matching
// the official deployments.
const GUARDIAN_SET_SECONDS_TO_LIVE = 86_400;
const GOVERNANCE_CHAIN = 1;
const GOVERNANCE_CONTRACT =
  "0000000000000000000000000000000000000000000000000000000000000004";
const MESSAGE_FEE = 0;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

export async function fetchCurrentGuardianSet() {
  const res = await fetch(`${WORMHOLESCAN_URL}/v1/guardianset/current`);
  if (!res.ok) throw new Error(`wormholescan ${res.status}`);
  const body = await res.json();
  const set = body.guardianSet ?? body;
  const index = Number(set.index);
  const addresses = set.addresses.map((a) =>
    (typeof a === "string" ? a : a.address).replace(/^0x/i, "").toLowerCase(),
  );
  if (!Number.isInteger(index) || addresses.length === 0) {
    throw new Error("unexpected wormholescan guardian set response");
  }
  return { index, addresses };
}

async function main() {
  const packageId = arg("package");
  const deployerCap = arg("deployer-cap");
  const upgradeCap = arg("upgrade-cap");

  const { index, addresses } = await fetchCurrentGuardianSet();
  console.log(`current guardian set: index ${index}, ${addresses.length} keys`);

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::setup::complete`,
    arguments: [
      tx.object(deployerCap),
      tx.object(upgradeCap),
      tx.pure.u16(GOVERNANCE_CHAIN),
      tx.pure(
        bcs
          .vector(bcs.u8())
          .serialize([...Buffer.from(GOVERNANCE_CONTRACT, "hex")])
          .toBytes(),
      ),
      tx.pure.u32(index),
      tx.pure(
        bcs
          .vector(bcs.vector(bcs.u8()))
          .serialize(addresses.map((a) => [...Buffer.from(a, "hex")]))
          .toBytes(),
      ),
      tx.pure.u32(GUARDIAN_SET_SECONDS_TO_LIVE),
      tx.pure.u64(MESSAGE_FEE),
    ],
  });

  const provider = client();
  const result = await provider.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair(),
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log(`digest: ${result.digest} (${result.effects?.status?.status})`);
  const shared = (result.objectChanges ?? []).find(
    (c) => c.type === "created" && c.objectType?.endsWith("::state::State"),
  );
  if (shared) console.log(`wormhole State: ${shared.objectId}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await main();
}
