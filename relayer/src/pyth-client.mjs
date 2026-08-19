// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Minimal port of the upstream Pyth Sui SDK client (target_chains/sui/sdk)
// to the Haneul TS SDK. Builds the programmable transaction commands for
// verifying Wormhole VAAs and creating/updating Pyth price feeds.

import { bcs } from "@haneullabs/haneul/bcs";
import { HANEUL_CLOCK_OBJECT_ID } from "@haneullabs/haneul/utils";

const MAX_ARGUMENT_SIZE = 16 * 1024;

export class HaneulPythClient {
  constructor(provider, pythStateId, wormholeStateId) {
    this.provider = provider;
    this.pythStateId = pythStateId;
    this.wormholeStateId = wormholeStateId;
    this.pythPackageId = undefined;
    this.wormholePackageId = undefined;
    this.priceTableInfo = undefined;
    this.priceFeedObjectIdCache = new Map();
    this.baseUpdateFee = undefined;
  }

  async getBaseUpdateFee() {
    if (this.baseUpdateFee === undefined) {
      const result = await this.provider.getObject({
        id: this.pythStateId,
        options: { showContent: true },
      });
      if (!result.data?.content || result.data.content.dataType !== "moveObject") {
        throw new Error("unable to fetch pyth state object");
      }
      this.baseUpdateFee = Number(result.data.content.fields.base_update_fee);
    }
    return this.baseUpdateFee;
  }

  // Latest package id an object belongs to, following upgrades via the
  // UpgradeCap stored in the state object.
  async getPackageId(objectId) {
    const result = await this.provider.getObject({
      id: objectId,
      options: { showContent: true },
    });
    const fields =
      result.data?.content?.dataType === "moveObject"
        ? result.data.content.fields
        : undefined;
    if (fields && "upgrade_cap" in fields) {
      return fields.upgrade_cap.fields.package;
    }
    throw new Error(`cannot fetch package id for object ${objectId}`);
  }

  async getWormholePackageId() {
    this.wormholePackageId ??= await this.getPackageId(this.wormholeStateId);
    return this.wormholePackageId;
  }

  async getPythPackageId() {
    this.pythPackageId ??= await this.getPackageId(this.pythStateId);
    return this.pythPackageId;
  }

  pureBytes(tx, bytes) {
    return tx.pure(
      bcs
        .vector(bcs.u8())
        .serialize([...bytes], { maxSize: MAX_ARGUMENT_SIZE })
        .toBytes(),
    );
  }

  async verifyVaa(tx, vaa) {
    const wormholePackageId = await this.getWormholePackageId();
    const [verified] = tx.moveCall({
      target: `${wormholePackageId}::vaa::parse_and_verify`,
      arguments: [
        tx.object(this.wormholeStateId),
        this.pureBytes(tx, vaa),
        tx.object(HANEUL_CLOCK_OBJECT_ID),
      ],
    });
    return verified;
  }

  // First 6 bytes of an accumulator message are header/major/minor; byte 6 is
  // the trailing payload size, then proof type (1 byte), then the u16 VAA size.
  extractVaaBytesFromAccumulatorMessage(message) {
    const trailingPayloadSize = message[6];
    const vaaSizeOffset = 7 + trailingPayloadSize + 1;
    const vaaSize = (message[vaaSizeOffset] << 8) | message[vaaSizeOffset + 1];
    const vaaOffset = vaaSizeOffset + 2;
    return message.subarray(vaaOffset, vaaOffset + vaaSize);
  }

  // Create price feed objects for feeds that do not exist yet.
  async createPriceFeeds(tx, accumulatorMessage) {
    const packageId = await this.getPythPackageId();
    const vaa = this.extractVaaBytesFromAccumulatorMessage(accumulatorMessage);
    const verified = await this.verifyVaa(tx, vaa);
    tx.moveCall({
      target: `${packageId}::pyth::create_price_feeds_using_accumulator`,
      arguments: [
        tx.object(this.pythStateId),
        this.pureBytes(tx, accumulatorMessage),
        verified,
        tx.object(HANEUL_CLOCK_OBJECT_ID),
      ],
    });
  }

  // Update existing price feed objects with a fresh accumulator message.
  async updatePriceFeeds(tx, accumulatorMessage, feedIds) {
    const packageId = await this.getPythPackageId();
    const vaa = this.extractVaaBytesFromAccumulatorMessage(accumulatorMessage);
    const verified = await this.verifyVaa(tx, vaa);

    let [hotPotato] = tx.moveCall({
      target: `${packageId}::pyth::create_authenticated_price_infos_using_accumulator`,
      arguments: [
        tx.object(this.pythStateId),
        this.pureBytes(tx, accumulatorMessage),
        verified,
        tx.object(HANEUL_CLOCK_OBJECT_ID),
      ],
    });

    const baseUpdateFee = await this.getBaseUpdateFee();
    const coins = tx.splitCoins(
      tx.gas,
      feedIds.map(() => tx.pure.u64(baseUpdateFee)),
    );

    const priceInfoObjects = [];
    let coinId = 0;
    for (const feedId of feedIds) {
      const priceInfoObjectId = await this.getPriceFeedObjectId(feedId);
      if (!priceInfoObjectId) {
        throw new Error(`price feed ${feedId} not found, create it first`);
      }
      priceInfoObjects.push(priceInfoObjectId);
      [hotPotato] = tx.moveCall({
        target: `${packageId}::pyth::update_single_price_feed`,
        arguments: [
          tx.object(this.pythStateId),
          hotPotato,
          tx.object(priceInfoObjectId),
          coins[coinId],
          tx.object(HANEUL_CLOCK_OBJECT_ID),
        ],
      });
      coinId++;
    }

    tx.moveCall({
      target: `${packageId}::hot_potato_vector::destroy`,
      typeArguments: [`${packageId}::price_info::PriceInfo`],
      arguments: [hotPotato],
    });
    return priceInfoObjects;
  }

  async getPriceFeedObjectId(feedId) {
    const normalized = feedId.replace("0x", "");
    if (!this.priceFeedObjectIdCache.has(normalized)) {
      const { id: tableId, fieldType } = await this.getPriceTableInfo();
      const result = await this.provider.getDynamicFieldObject({
        parentObjectId: tableId,
        name: {
          type: `${fieldType}::price_identifier::PriceIdentifier`,
          value: { bytes: [...Buffer.from(normalized, "hex")] },
        },
      });
      if (!result.data?.content) return undefined;
      if (result.data.content.dataType !== "moveObject") {
        throw new Error("price feed type mismatch");
      }
      this.priceFeedObjectIdCache.set(
        normalized,
        result.data.content.fields.value,
      );
    }
    return this.priceFeedObjectIdCache.get(normalized);
  }

  async getPriceTableInfo() {
    if (this.priceTableInfo === undefined) {
      const result = await this.provider.getDynamicFieldObject({
        parentObjectId: this.pythStateId,
        name: { type: "vector<u8>", value: "price_info" },
      });
      if (!result.data?.type) {
        throw new Error("price table not found, contract may not be initialized");
      }
      let type = result.data.type.replace("0x2::table::Table<", "");
      type = type.replace("::price_identifier::PriceIdentifier, 0x2::object::ID>", "");
      this.priceTableInfo = { fieldType: type, id: result.data.objectId };
    }
    return this.priceTableInfo;
  }
}
