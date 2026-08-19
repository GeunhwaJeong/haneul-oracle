// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Guardian set synchronizer: keeps the on-chain guardian set current so VAA
// verification keeps working after the Wormhole guardians rotate (three
// rotations happened in 2026 alone). Falling behind halts price updates but
// never corrupts existing prices; catching up is a permissionless VAA submit.
//
// Guardian set upgrade VAAs are global governance (target chain 0) emitted by
// the Wormhole governance emitter on Solana. They are discovered from the
// public Wormholescan API, so future rotations need no code changes.
//
// Usage: RELAYER_KEY=... WORMHOLE_STATE_ID=... node src/sync-guardian-sets.mjs [--once]

import { bcs } from "@haneullabs/haneul/bcs";
import { Transaction } from "@haneullabs/haneul/transactions";
import { HANEUL_CLOCK_OBJECT_ID } from "@haneullabs/haneul/utils";

import { WORMHOLESCAN_URL, WORMHOLE_STATE_ID, client, keypair } from "./config.mjs";
import { fetchCurrentGuardianSet } from "./init-wormhole.mjs";

const CHECK_INTERVAL_SECS = Number(process.env.SYNC_INTERVAL_SECS ?? 6 * 3600);
const GOVERNANCE_EMITTER =
  "0000000000000000000000000000000000000000000000000000000000000004";
const once = process.argv.includes("--once");

if (!WORMHOLE_STATE_ID) {
  console.error("WORMHOLE_STATE_ID must be set");
  process.exit(1);
}

const provider = client();

async function getOnChainState() {
  const result = await provider.getObject({
    id: WORMHOLE_STATE_ID,
    options: { showContent: true },
  });
  const fields = result.data?.content?.fields;
  if (!fields) throw new Error("cannot read wormhole state");
  return {
    index: Number(fields.guardian_set_index),
    packageId: fields.upgrade_cap.fields.package,
  };
}

// Known upgrade VAAs shipped with the repo (indices 1..7, each signed by the
// previous guardian set). Checked first because Wormholescan's VAA listing
// for the governance emitter has proven to lag behind actual rotations.
async function findEmbeddedUpgradeVaa(wanted) {
  const { readFile } = await import("node:fs/promises");
  const path = new URL("../data/guardian-set-upgrades.json", import.meta.url);
  const known = JSON.parse(await readFile(path, "utf8"));
  const hit = known.find((k) => k.newIndex === wanted);
  return hit ? Buffer.from(hit.vaa, "hex") : undefined;
}

// List governance VAAs from Wormholescan and keep Core guardian-set upgrades
// (module "Core", action 2, target chain 0) whose new index is `wanted`.
async function findUpgradeVaa(wanted) {
  const embedded = await findEmbeddedUpgradeVaa(wanted);
  if (embedded) return embedded;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(
      `${WORMHOLESCAN_URL}/api/v1/vaas/1/${GOVERNANCE_EMITTER}?page=${page}&pageSize=50`,
    );
    if (!res.ok) throw new Error(`wormholescan ${res.status}`);
    const { data } = await res.json();
    if (!data?.length) break;
    for (const row of data) {
      const raw = Buffer.from(row.vaa, "base64");
      const nsig = raw[5];
      const payload = raw.subarray(6 + 66 * nsig + 51);
      const isCore =
        payload.subarray(0, 28).every((b) => b === 0) &&
        payload.subarray(28, 32).toString() === "Core";
      if (!isCore || payload[32] !== 2) continue;
      const targetChain = payload.readUInt16BE(33);
      const newIndex = payload.readUInt32BE(35);
      if (targetChain === 0 && newIndex === wanted) return raw;
    }
  }
  return undefined;
}

async function submitUpgrade(packageId, vaa) {
  const tx = new Transaction();
  const [verified] = tx.moveCall({
    target: `${packageId}::vaa::parse_and_verify`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      tx.pure(bcs.vector(bcs.u8()).serialize([...vaa]).toBytes()),
      tx.object(HANEUL_CLOCK_OBJECT_ID),
    ],
  });
  const [ticket] = tx.moveCall({
    target: `${packageId}::update_guardian_set::authorize_governance`,
    arguments: [tx.object(WORMHOLE_STATE_ID)],
  });
  const [receipt] = tx.moveCall({
    target: `${packageId}::governance_message::verify_vaa`,
    typeArguments: [`${packageId}::update_guardian_set::GovernanceWitness`],
    arguments: [tx.object(WORMHOLE_STATE_ID), verified, ticket],
  });
  tx.moveCall({
    target: `${packageId}::update_guardian_set::update_guardian_set`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      receipt,
      tx.object(HANEUL_CLOCK_OBJECT_ID),
    ],
  });
  return provider.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair(),
    options: { showEffects: true },
  });
}

async function syncOnce() {
  const [{ index: onChain, packageId }, { index: current }] =
    await Promise.all([getOnChainState(), fetchCurrentGuardianSet()]);
  if (onChain >= current) {
    console.log(`guardian set in sync at index ${onChain}`);
    return;
  }
  console.log(`guardian set behind: on-chain ${onChain}, current ${current}`);
  for (let next = onChain + 1; next <= current; next++) {
    const vaa = await findUpgradeVaa(next);
    if (!vaa) {
      console.error(
        `CRITICAL: upgrade VAA for guardian set ${next} not found on ` +
          `Wormholescan; price updates will halt until it is submitted`,
      );
      return;
    }
    const result = await submitUpgrade(packageId, vaa);
    console.log(
      `submitted guardian set ${next}: ${result.digest} ` +
        `(${result.effects?.status?.status})`,
    );
  }
}

for (;;) {
  try {
    await syncOnce();
  } catch (err) {
    console.error("sync error:", err.message ?? err);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, CHECK_INTERVAL_SECS * 1000));
}
