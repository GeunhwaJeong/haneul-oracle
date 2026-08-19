// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { HaneulJsonRpcClient } from "@haneullabs/haneul/jsonRpc";
import { Ed25519Keypair } from "@haneullabs/haneul/keypairs/ed25519";
import { decodeHaneulPrivateKey } from "@haneullabs/haneul/cryptography";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:9000";
export const HERMES_URL =
  process.env.HERMES_URL ?? "https://hermes.pyth.network";
export const WORMHOLESCAN_URL =
  process.env.WORMHOLESCAN_URL ?? "https://api.wormholescan.io";

// Shared object ids of the deployed states; set after deployment.
export const PYTH_STATE_ID = process.env.PYTH_STATE_ID;
export const WORMHOLE_STATE_ID = process.env.WORMHOLE_STATE_ID;

// Price feed ids to relay (hex, no 0x). Defaults: BTC/USD, ETH/USD.
export const FEED_IDS = (
  process.env.FEED_IDS ??
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43," +
    "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
)
  .split(",")
  .map((s) => s.trim().replace(/^0x/i, ""))
  .filter(Boolean);

// Reject malformed feed ids at startup. Hermes rejects the whole batch request
// if any id is invalid, so one bad entry would silently halt every feed.
for (const id of FEED_IDS) {
  if (!/^[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error(`invalid feed id (want 64 hex chars): ${id}`);
  }
}
if (FEED_IDS.length === 0) throw new Error("FEED_IDS is empty");

// How often the relayer pushes fresh prices, in seconds. Guard against NaN,
// which would make setTimeout fire immediately and hot-loop the daemon.
export const RELAY_INTERVAL_SECS = (() => {
  const n = Number(process.env.RELAY_INTERVAL_SECS ?? 300);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid RELAY_INTERVAL_SECS: ${process.env.RELAY_INTERVAL_SECS}`);
  }
  return n;
})();

export function client() {
  return new HaneulJsonRpcClient({ url: RPC_URL, network: "unknown" });
}

export function keypair() {
  const secret = process.env.RELAYER_KEY;
  if (!secret) {
    throw new Error(
      "RELAYER_KEY is not set (expected a haneulprivkey1... bech32 string)",
    );
  }
  const { secretKey } = decodeHaneulPrivateKey(secret);
  return Ed25519Keypair.fromSecretKey(secretKey);
}
