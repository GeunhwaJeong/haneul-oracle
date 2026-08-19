// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Publish a compiled Move package. Feed it the JSON printed by
// `haneul move build --dump-bytecode-as-base64`.
//
// Usage: RELAYER_KEY=... node src/publish.mjs --bytecode <path-to-json>

import { readFile } from "node:fs/promises";

import { Transaction } from "@haneullabs/haneul/transactions";

import { client, keypair } from "./config.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const { modules, dependencies } = JSON.parse(
  await readFile(arg("bytecode"), "utf8"),
);

const signer = keypair();
const tx = new Transaction();
const [upgradeCap] = tx.publish({ modules, dependencies });
tx.transferObjects([upgradeCap], signer.toHaneulAddress());

const provider = client();
const result = await provider.signAndExecuteTransaction({
  transaction: tx,
  signer,
  options: { showEffects: true, showObjectChanges: true },
});
console.log(`digest: ${result.digest} (${result.effects?.status?.status})`);
for (const c of result.objectChanges ?? []) {
  if (c.type === "published") {
    console.log(`package: ${c.packageId}`);
  } else if (c.type === "created") {
    console.log(`created: ${c.objectType} ${c.objectId}`);
  }
}
