// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Staking__factory } from '@subql/contract-sdk';
import {
  DelegationAddedEvent,
  DelegationRemovedEvent,
  UnbondRequestedEvent,
  UnbondWithdrawnEvent,
  UnbondCancelledEvent,
} from '@subql/contract-sdk/typechain/Staking';
import assert from 'assert';
import {
  Delegation,
  Withdrawl,
  WithdrawalStatus,
  WithdrawalType,
  Indexer,
  IndexerStakeSummary,
  IndexerStake,
} from '../types';
import {
  updateTotalStake,
  upsertEraValue,
  updateTotalDelegation,
  reportException,
  updateTotalLock,
  updateIndexerCapacity,
  getWithdrawlId,
  getDelegationId,
  updateMaxUnstakeAmount,
  biToDate,
  getContractAddress,
  Contracts,
} from './utils';
import { EthereumLog } from '@subql/types-ethereum';
import { CreateWithdrawlParams } from '../interfaces';
import { getWithdrawalType } from './utils/enumToTypes';
import { getCurrentEra } from './eraManager';
import { BigNumber } from 'ethers';

const { ONGOING, CLAIMED, CANCELLED } = WithdrawalStatus;

async function createWithdrawl({
  id,
  delegator,
  indexer,
  index,
  amount,
  type,
  status,
  event,
}: CreateWithdrawlParams): Promise<void> {
  const { block, blockNumber } = event;
  let withdrawl = await Withdrawl.get(id);

  if (withdrawl) {
    withdrawl.amount = amount.toBigInt();
    withdrawl.type = type;
    withdrawl.startTime = biToDate(block.timestamp);
    withdrawl.createdBlock = blockNumber;
  } else {
    withdrawl = Withdrawl.create({
      id,
      delegator: delegator,
      indexer: indexer,
      index: index.toBigInt(),
      startTime: biToDate(block.timestamp),
      amount: amount.toBigInt(),
      type,
      status,
      createdBlock: blockNumber,
    });
  }
  await withdrawl.save();
}

export async function handleAddDelegation(
  event: EthereumLog<DelegationAddedEvent['args']>
): Promise<void> {
  logger.info('handleAddDelegation');
  assert(event.args, 'No event args');

  const { source, indexer, amount } = event.args;
  const id = getDelegationId(source, indexer);

  const amountBn = amount.toBigInt();
  let delegation = await Delegation.get(id);

  await updateTotalDelegation(
    source,
    amountBn,
    'add',
    indexer === source && !delegation
  );

  await updateTotalStake(
    indexer,
    amountBn,
    'add',
    event,
    indexer === source && !delegation
  );

  if (!delegation) {
    // Indexers first stake is effective immediately
    const eraAmount = await upsertEraValue(
      undefined,
      amountBn,
      'add',
      indexer === source
    );

    delegation = Delegation.create({
      id,
      delegatorId: source,
      indexerId: indexer,
      amount: eraAmount,
      createdBlock: event.blockNumber,
    });
  } else {
    delegation.amount = await upsertEraValue(delegation.amount, amountBn);
  }

  if (BigInt.fromJSONType(delegation.amount.valueAfter) > BigInt(0)) {
    delegation.exitEra = undefined;
  }
  await updateTotalLock(amountBn, 'add', indexer === source, event);
  await delegation.save();
  await updateIndexerCapacity(indexer, event);
  await updateMaxUnstakeAmount(indexer, event);
  await updateIndexerStakeSummaryAdded(event);
}

export async function handleRemoveDelegation(
  event: EthereumLog<DelegationRemovedEvent['args']>
): Promise<void> {
  logger.info('handleRemoveDelegation');
  assert(event.args, 'No event args');

  const { source, indexer, amount } = event.args;
  const id = getDelegationId(source, indexer);
  const delegation = await Delegation.get(id);

  // Entity has already been removed when indexer unregisters
  if (!delegation) return;

  delegation.amount = await upsertEraValue(
    delegation.amount,
    amount.toBigInt(),
    'sub'
  );

  if (BigInt.fromJSONType(delegation.amount.valueAfter) === BigInt(0)) {
    delegation.exitEra = delegation.amount.era + 1;
  }

  await updateTotalDelegation(source, amount.toBigInt(), 'sub');
  await updateTotalStake(indexer, amount.toBigInt(), 'sub', event);
  await updateTotalLock(amount.toBigInt(), 'sub', indexer === source, event);

  await delegation.save();
  await updateIndexerCapacity(indexer, event);
  await updateMaxUnstakeAmount(indexer, event);
}

export async function handleWithdrawRequested(
  event: EthereumLog<UnbondRequestedEvent['args']>
): Promise<void> {
  logger.info('handleWithdrawRequested');
  assert(event.args, 'No event args');

  const { source, indexer, amount, index, _type } = event.args;
  const id = getWithdrawlId(source, index);

  let updatedAmount = amount;

  const network = await api.getNetwork();
  if (getWithdrawalType(_type) === WithdrawalType.MERGE) {
    const staking = Staking__factory.connect(
      getContractAddress(network.chainId, Contracts.STAKING_ADDRESS),
      api
    );
    const { amount: unbondingAmount } = await staking.unbondingAmount(
      indexer,
      index
    );
    updatedAmount = updatedAmount.add(unbondingAmount);
  }

  await createWithdrawl({
    id,
    delegator: source,
    indexer,
    index,
    amount: updatedAmount,
    type: getWithdrawalType(_type),
    status: ONGOING,
    event,
  });
}

/**
 *
 * TOFIX:
 * Issue at height 1505302
 * handleWithdrawClaimed event trigger ahead handleWithdrawRequested event
 *
 */
export async function handleWithdrawClaimed(
  event: EthereumLog<UnbondWithdrawnEvent['args']>
): Promise<void> {
  logger.info('handleWithdrawClaimed');
  assert(event.args, 'No event args');

  const { source, index } = event.args;
  const id = getWithdrawlId(source, index);

  const withdrawl = await Withdrawl.get(id);

  if (withdrawl) {
    withdrawl.status = CLAIMED;
    withdrawl.lastEvent = `handleWithdrawClaimed:${event.blockNumber}`;

    await withdrawl.save();
  } else {
    logger.warn(`Force upsert: Expected withdrawl ${id} to exist.`);
    const exception = `Expected withdrawl ${id} to exist: ${JSON.stringify(
      event
    )}`;

    await reportException('handleWithdrawClaimed', exception, event);
  }
}

export async function handleWithdrawCancelled(
  event: EthereumLog<UnbondCancelledEvent['args']>
): Promise<void> {
  logger.info('handleWithdrawClaimed');
  assert(event.args, 'No event args');

  const { source, index } = event.args;
  const id = getWithdrawlId(source, index);
  const withdrawl = await Withdrawl.get(id);

  if (withdrawl) {
    withdrawl.status = CANCELLED;
    withdrawl.lastEvent = `handleWithdrawCancelled:${event.blockNumber}`;
    await withdrawl.save();
  } else {
    logger.warn(`Force upsert: Expected withdrawl ${id} to exist.`);
    const exception = `Expected withdrawl ${id} to exist: ${JSON.stringify(
      event
    )}`;

    await reportException('handleWithdrawCancelled', exception, event);
  }
}

async function updateIndexerStakeSummaryAdded(
  event: EthereumLog<DelegationAddedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { source, indexer, amount } = event.args;
  const amountBn = amount.toBigInt();

  const indexerEntity = await Indexer.get(indexer);
  assert(indexerEntity, `Indexer ${indexer} does not exist`);

  let newIndexerStake = BigInt(0);
  let newDelegatorStake = BigInt(0);

  if (source === indexer) {
    newIndexerStake = amountBn;
  } else {
    newDelegatorStake = amountBn;
  }
  const currEraIdx = await getCurrentEra();
  const currEraId = BigNumber.from(currEraIdx).toHexString();
  const nextEraIdx = currEraIdx + 1;
  const nextEraId = BigNumber.from(nextEraIdx).toHexString();

  // update IndexerStakeSummary

  let indexerStakeSummary = await IndexerStakeSummary.get(indexer);
  let isFirstStake = false;

  if (!indexerStakeSummary) {
    isFirstStake = true;
  } else if (
    indexerStakeSummary.eraId === currEraId &&
    indexerStakeSummary.totalStake === BigInt(0)
  ) {
    isFirstStake = true;
  } else if (
    indexerStakeSummary.eraId !== currEraId &&
    indexerStakeSummary.nextTotalStake === BigInt(0)
  ) {
    isFirstStake = true;
  }

  if (!indexerStakeSummary) {
    indexerStakeSummary = IndexerStakeSummary.create({
      id: indexer,
      eraId: currEraId,
      totalStake: amountBn,
      indexerStake: newIndexerStake,
      delegatorStake: newDelegatorStake,
      nextTotalStake: BigInt(0),
      nextIndexerStake: BigInt(0),
      nextDelegatorStake: BigInt(0),
    });
  } else if (isFirstStake) {
    indexerStakeSummary.totalStake = amountBn;
    indexerStakeSummary.indexerStake = newIndexerStake;
    indexerStakeSummary.delegatorStake = newDelegatorStake;
  } else if (indexerStakeSummary.eraId !== currEraId) {
    indexerStakeSummary.totalStake = indexerStakeSummary.nextTotalStake;
    indexerStakeSummary.indexerStake = indexerStakeSummary.nextIndexerStake;
    indexerStakeSummary.delegatorStake = indexerStakeSummary.nextDelegatorStake;
  }

  indexerStakeSummary.eraId = currEraId;
  indexerStakeSummary.nextTotalStake += amountBn;
  indexerStakeSummary.nextIndexerStake += newIndexerStake;
  indexerStakeSummary.nextDelegatorStake += newDelegatorStake;
  await indexerStakeSummary.save();

  // update IndexerState

  const currIndexerStakeId = `${indexer}_${currEraId}`;
  const nextIndexerStakeId = `${indexer}_${nextEraId}`;

  if (isFirstStake) {
    const currIndexerStake = IndexerStake.create({
      id: currIndexerStakeId,
      eraId: currEraId,
      totalStake: amountBn,
      indexerStake: newIndexerStake,
      delegatorStake: newDelegatorStake,
    });
    await currIndexerStake.save();
  }

  let nextIndexerStake = await IndexerStake.get(nextIndexerStakeId);
  if (!nextIndexerStake) {
    nextIndexerStake = IndexerStake.create({
      id: nextIndexerStakeId,
      eraId: nextEraId,
      totalStake: indexerStakeSummary.nextTotalStake,
      indexerStake: indexerStakeSummary.nextIndexerStake,
      delegatorStake: indexerStakeSummary.nextDelegatorStake,
    });
  } else {
    nextIndexerStake.totalStake = indexerStakeSummary.nextTotalStake;
    nextIndexerStake.indexerStake = indexerStakeSummary.nextIndexerStake;
    nextIndexerStake.delegatorStake = indexerStakeSummary.nextDelegatorStake;
  }
  await nextIndexerStake.save();
}

// async function updateIndexerStakeSummaryRemoved(
//   event: EthereumLog<DelegationRemovedEvent['args']>
// ): Promise<void> {}
