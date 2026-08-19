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

// A Move abort does NOT reject signAndExecuteTransaction; it returns effects
// with status "failure". Treat anything but success as an error so the daemon
// logs it at error level and drops stale caches, instead of printing a
// success-shaped line while the oracle silently goes stale.
async function execute(tx, label) {
  const result = await provider.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  const status = result.effects?.status?.status;
  if (status !== "success") {
    pyth.invalidateCaches();
    throw new Error(
      `${label} failed on chain: ${result.effects?.status?.error ?? status} ` +
        `(${result.digest})`,
    );
  }
  return result;
}

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
    const result = await execute(tx, `create ${missing.length} feed(s)`);
    console.log(`created ${missing.length} price feed(s): ${result.digest}`);
    // Newly created feed objects become available next round.
    return;
  }

  const tx = new Transaction();
  await pyth.updatePriceFeeds(tx, message, existing);
  const result = await execute(tx, `update ${existing.length} feed(s)`);
  const prices = parsed
    .map((p) => `${p.id.slice(0, 8)}=${p.price?.price}e${p.price?.expo}`)
    .join(" ");
  console.log(
    `updated ${existing.length} feed(s): ${result.digest} ${prices}`,
  );
}

async function main() {
  console.log(
    `relayer starting: ${FEED_IDS.length} feed(s), ` +
      `interval ${RELAY_INTERVAL_SECS}s, sender ${signer.toHaneulAddress()}`,
  );
  let lastError;
  for (;;) {
    try {
      await relayOnce();
      lastError = undefined;
    } catch (err) {
      lastError = err;
      console.error("relay error:", err.message ?? err);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, RELAY_INTERVAL_SECS * 1000));
  }
  // In --once mode surface failure through the exit code for cron/systemd.
  if (lastError) process.exit(1);
}

await main();
