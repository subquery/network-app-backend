// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { EthereumLog } from '@subql/types-ethereum';
import { AirdropAmount } from '../../types';

export const getUpsertAt = (handler: string, event: EthereumLog): string => {
  const upsertAt = `${handler}:${event.blockNumber}:${
    event.transactionHash ?? ''
  }`;
  return upsertAt;
};

export const getErrorText = (handler: string, error: string): string => {
  return `${handler}:${error}`;
};

export const toBigNumber = (amount: BigNumberish): BigNumber =>
  BigNumber.from(amount.toString());

export const upsertUser = async (
  address: string,
  airdropAmount: BigNumberish,
  claimedAmount: BigNumberish,
  event: EthereumLog
): Promise<void> => {
  const HANDLER = 'upsertUser';
  const user = await AirdropAmount.get(address);

  if (user) {
    user.totalAirdropAmount = toBigNumber(user.totalAirdropAmount)
      .add(toBigNumber(airdropAmount))
      .toBigInt();
    user.claimedAmount = toBigNumber(user.claimedAmount)
      .add(toBigNumber(claimedAmount))
      .toBigInt();
    user.updateAt = getUpsertAt(HANDLER, event);

    await user.save();
  } else {
    logger.info(`${HANDLER} - create: ${event.transactionHash ?? ''}`);
    const newAddress = new AirdropAmount(
      address,
      toBigNumber(airdropAmount).toBigInt(),
      toBigNumber(claimedAmount).toBigInt()
    );

    newAddress.createAt = getUpsertAt(HANDLER, event);
    await newAddress.save();
  }
};
