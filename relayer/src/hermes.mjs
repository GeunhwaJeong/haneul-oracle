// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_URL } from "./config.mjs";

// Fetch the latest accumulator update message for the given feed ids from the
// public Hermes API. Returns one binary message covering all feeds.
export async function fetchLatestUpdate(feedIds) {
  const params = new URLSearchParams();
  for (const id of feedIds) params.append("ids[]", id);
  params.set("encoding", "base64");
  const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${params}`);
  if (!res.ok) {
    throw new Error(`hermes ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const data = body?.binary?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("hermes returned no update data");
  }
  if (data.length > 1) {
    throw new Error("expected a single accumulator message per request");
  }
  return {
    message: Buffer.from(data[0], "base64"),
    parsed: body.parsed ?? [],
  };
}
