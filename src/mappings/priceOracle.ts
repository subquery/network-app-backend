// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { PricePostedEvent } from '@subql/contract-sdk/typechain/contracts/PriceOracle';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { PriceOracle } from '../types';

export async function handlePricePosted(
  event: EthereumLog<PricePostedEvent['args']>
): Promise<void> {
  logger.info('handlePricePosted');
  assert(event.args, 'No event args');

  const { assetFrom, assetTo, previousPrice, newPrice } = event.args;

  const blockNum = event.blockNumber;

  const price = PriceOracle.create({
    id: `${assetFrom}-${assetTo}-${blockNum}`,
    fromToken: assetFrom,
    toToken: assetTo,
    beforePrice: previousPrice.toBigInt(),
    afterPrice: newPrice.toBigInt(),
    createdBlock: blockNum,
  });

  await price.save();
}
