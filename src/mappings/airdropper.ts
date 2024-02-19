// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  AddAirdropEvent,
  AirdropClaimedEvent,
  RoundCreatedEvent,
  RoundSettledEvent,
} from '@subql/contract-sdk/typechain/contracts/Airdropper';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { Airdrop, AirdropClaimStatus, AirdropUser } from '../types';
import { reportException, upsertAirdropper } from './utils';

const getAirdropUserId = (roundId: string, address: string) =>
  `${roundId}:${address}`;

export async function handleRoundCreated(
  event: EthereumLog<RoundCreatedEvent['args']>
): Promise<void> {
  const HANDLER = 'handleRoundCreated';
  logger.info(HANDLER);
  assert(event.args, 'No event args');

  const { roundId, roundDeadline, roundStartTime, tokenAddress } = event.args;

  const airdropRound = Airdrop.create({
    id: roundId.toString(),
    startTime: new Date(roundStartTime.toNumber() * 1000), // seconds return from contract and manipulate into milliseconds / Date object.
    endTime: new Date(roundDeadline.toNumber() * 1000), // seconds return from contract and manipulate into milliseconds / Date object.
    tokenAddress,
    createAt: `${HANDLER}:${event.blockNumber}`,
  });

  await airdropRound.save();
}

export async function handleRoundSettled(
  event: EthereumLog<RoundSettledEvent['args']>
): Promise<void> {
  const HANDLER = 'handleRoundSettled';
  logger.info(HANDLER);
  assert(event.args, 'No event args');

  const { roundId, unclaimAmount } = event.args;
  const roundIdString = roundId.toString();
  const airdrop = await Airdrop.get(roundIdString);

  if (airdrop) {
    airdrop.withdrawAmount = unclaimAmount.toBigInt();
    airdrop.hasWithdrawn = true;
    airdrop.updateAt = `${HANDLER}:${event.blockNumber}`;
  } else {
    const error = `Expect roundId - ${roundIdString} exit`;
    await reportException(HANDLER, error, event);
    logger.error(error);
  }
}

export async function handleAddAirdrop(
  event: EthereumLog<AddAirdropEvent['args']>
): Promise<void> {
  const HANDLER = 'handleAddAirdrop';
  logger.info(HANDLER);
  assert(event.args, 'No event args');

  const { addr, roundId, amount } = event.args;
  const roundIdString = roundId.toString();
  const airdrop = await Airdrop.get(roundIdString);
  logger.info(`handleAddAirdrop: ${roundIdString}`);

  if (airdrop) {
    logger.info(`upsertUser: ${getAirdropUserId(roundIdString, addr)}`);
    await upsertAirdropper(addr, amount, '0', event);

    const airdropUser = AirdropUser.create({
      id: getAirdropUserId(roundIdString, addr),
      user: addr,
      airdropId: roundId.toString(),
      amount: amount.toBigInt(),
      status: AirdropClaimStatus.UNCLAIMED,
      createAt: `${HANDLER}:${event.blockNumber}`,
    });

    await airdropUser.save();
  } else {
    const error = `Expect roundId - ${roundIdString} exit`;
    await reportException(HANDLER, error, event);
    logger.error(error);
  }
}

export async function handleAirdropClaimed(
  event: EthereumLog<AirdropClaimedEvent['args']>
): Promise<void> {
  const HANDLER = 'handleAirdropClaimed';
  logger.info(HANDLER);
  assert(event.args, 'No event args');

  const { addr, roundId, amount } = event.args;
  const roundIdString = roundId.toString();
  const airdrop = await Airdrop.get(roundIdString);
  const airdropUserId = getAirdropUserId(roundIdString, addr);
  const airdropUser = await AirdropUser.get(airdropUserId);

  if (!airdrop) {
    const error = `Expect roundId - ${roundIdString} exit`;
    await reportException(HANDLER, error, event);
    logger.error(error);
    return;
  }

  if (!airdropUser) {
    const error = `Expect airdropUser - ${airdropUserId} exit`;
    await reportException(HANDLER, error, event);
    logger.error(error);
    return;
  }

  await upsertAirdropper(addr, '0', amount.toString(), event);

  airdropUser.status = AirdropClaimStatus.CLAIMED;
  (airdropUser.updateAt = `${HANDLER}:${event.blockNumber}`),
    await airdropUser.save();
}
