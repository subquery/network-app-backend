// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { TransferEvent } from '@subql/contract-sdk/typechain/SQToken';
import { EthereumLog } from '@subql/types-ethereum';
import { ethers } from 'ethers';
import { Sqtoken, TokenHolder, Transfer } from '../types';
import assert from 'assert';

const TreasuryAddr = '0x34c35136ECe9CBD6DfDf2F896C6e29be01587c0C'.toLowerCase();
const AirdropperAddr =
  '0x22Ab0be7a2eC82a983883839f7d5b4B12F5EbddC'.toLowerCase();

function isReservedContract(address: string): boolean {
  return [TreasuryAddr, AirdropperAddr].includes(address.toLowerCase());
}

export async function handleTransfer(
  event: EthereumLog<TransferEvent['args']>
): Promise<void> {
  logger.info(`New transfer transaction log at block ${event.blockNumber}`);
  assert(event.args, 'No event args');
  const { from, to, value } = event.args;
  const transfer = Transfer.create({
    id: event.transactionHash,
    from,
    to,
    amount: value.toBigInt(),
    timestamp: new Date(Number(event.block.timestamp) * 1000),
    blockheight: BigInt(event.blockNumber),
  });
  await transfer.save();
  const tokenAddr = event.address;
  // #1 Process TokenHolder, (skip empty address)
  if (from !== ethers.constants.AddressZero) {
    let fromAccount = await TokenHolder.get(from);
    if (!fromAccount) {
      fromAccount = new TokenHolder(from, BigInt(0), tokenAddr);
    } else {
      fromAccount.balance = fromAccount.balance - event.args.value.toBigInt();
    }
    await fromAccount.save();
  }
  if (to !== ethers.constants.AddressZero) {
    let toAccount = await TokenHolder.get(to);
    if (!toAccount) {
      toAccount = new TokenHolder(to, BigInt(0), tokenAddr);
    }
    toAccount.balance = toAccount.balance + event.args.value.toBigInt();
    await toAccount.save();
  }
  // #2 Maintain circulatingSupply
  // mint: add circulatingSupply
  logger.info(`found transfer from ${from} to ${to}`);
  let token = await Sqtoken.get(tokenAddr);
  if (!token) {
    const circulatingSupply = !isReservedContract(to)
      ? event.args.value.toBigInt()
      : BigInt(0);
    token = new Sqtoken(
      tokenAddr,
      event.args.value.toBigInt(),
      circulatingSupply
    );
    if (!isReservedContract(to)) {
      logger.info(`circulatingSupply increase ${event.args.value.toBigInt()}`);
    }
  }
  if (from === ethers.constants.AddressZero) {
    logger.info(`Mint at block ${event.blockNumber} from ${from}`);
    if (!token) {
      const circulatingSupply = !isReservedContract(to)
        ? event.args.value.toBigInt()
        : BigInt(0);
      token = new Sqtoken(
        tokenAddr,
        event.args.value.toBigInt(),
        circulatingSupply
      );
      if (!isReservedContract(to)) {
        logger.info(
          `circulatingSupply increase ${event.args.value.toBigInt()}`
        );
      }
    } else {
      token.totalSupply = token.totalSupply + event.args.value.toBigInt();
      token.circulatingSupply =
        token.circulatingSupply + event.args.value.toBigInt();
      logger.info(
        `circulatingSupply increase ${event.args.value.toBigInt()} to ${
          token.circulatingSupply
        }`
      );
    }
    await token.save();
  }
  // burn: remove circulatingSupply
  if (to === ethers.constants.AddressZero) {
    logger.info(`Burn at block ${event.blockNumber} from ${from}`);
    token.totalSupply = token.totalSupply - event.args.value.toBigInt();
    token.circulatingSupply =
      token.circulatingSupply - event.args.value.toBigInt();
    logger.info(
      `circulatingSupply decrease ${event.args.value.toBigInt()} to ${
        token.circulatingSupply
      }`
    );
    await token.save();
  }
  // treasury out: add circulatingSupply
  if (isReservedContract(from)) {
    token.circulatingSupply =
      token.circulatingSupply + event.args.value.toBigInt();
    logger.info(
      `circulatingSupply increase ${event.args.value.toBigInt()} to ${
        token.circulatingSupply
      }`
    );
    await token.save();
  }
  // treasury in: remove circulatingSupply
  if (isReservedContract(to)) {
    token.circulatingSupply =
      token.circulatingSupply - event.args.value.toBigInt();
    logger.info(
      `circulatingSupply decrease ${event.args.value.toBigInt()} to ${
        token.circulatingSupply
      }`
    );
    await token.save();
  }
}
