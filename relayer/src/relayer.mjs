// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Price relayer daemon: periodically pulls the latest signed price updates
// for the configured feeds from Hermes and submits them on chain. Submission
// is permissionless; this wallet only pays gas and update fees.

import { Transaction } from "@haneullabs/haneul/transactions";

import {
  FEED_IDS,
  PYTH_STATE_ID,
  RELAY_INTERVAL_SECS,
  WORMHOLE_STATE_ID,
  client,
  keypair,
} from "./config.mjs";
import { fetchLatestUpdate } from "./hermes.mjs";
import { HaneulPythClient } from "./pyth-client.mjs";

const once = process.argv.includes("--once");

if (!PYTH_STATE_ID || !WORMHOLE_STATE_ID) {
  console.error("PYTH_STATE_ID and WORMHOLE_STATE_ID must be set");
  process.exit(1);
}

const provider = client();
const signer = keypair();
const pyth = new HaneulPythClient(provider, PYTH_STATE_ID, WORMHOLE_STATE_ID);

async function relayOnce() {
  const { message, parsed } = await fetchLatestUpdate(FEED_IDS);

  // Feeds that do not have a PriceInfoObject yet must be created first.
  const missing = [];
  const existing = [];
  for (const feedId of FEED_IDS) {
    if (await pyth.getPriceFeedObjectId(feedId)) existing.push(feedId);
    else missing.push(feedId);
  }

  if (missing.length > 0) {
    const tx = new Transaction();
    await pyth.createPriceFeeds(tx, message);
    const result = await provider.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true },
    });
    console.log(
      `created ${missing.length} price feed(s): ${result.digest} ` +
        `(${result.effects?.status?.status})`,
    );
    // Newly created feed objects become available next round.
    return;
  }

  const tx = new Transaction();
  await pyth.updatePriceFeeds(tx, message, existing);
  const result = await provider.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  const prices = parsed
    .map((p) => `${p.id.slice(0, 8)}=${p.price?.price}e${p.price?.expo}`)
    .join(" ");
  console.log(
    `updated ${existing.length} feed(s): ${result.digest} ` +
      `(${result.effects?.status?.status}) ${prices}`,
  );
}

async function main() {
  console.log(
    `relayer starting: ${FEED_IDS.length} feed(s), ` +
      `interval ${RELAY_INTERVAL_SECS}s, sender ${signer.toHaneulAddress()}`,
  );
  for (;;) {
    try {
      await relayOnce();
    } catch (err) {
      console.error("relay error:", err.message ?? err);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, RELAY_INTERVAL_SECS * 1000));
  }
}

await main();
