// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Staking__factory } from '@subql/contract-sdk';
import {
  DelegationAddedEvent,
  DelegationRemovedEvent,
  UnbondCancelledEvent,
  UnbondRequestedEvent,
  UnbondWithdrawnEvent,
} from '@subql/contract-sdk/typechain/Staking';
import assert from 'assert';
import {
  Delegation,
  IndexerStake,
  IndexerStakeSummary,
  WithdrawalStatus,
  WithdrawalType,
  Withdrawl,
} from '../types';
import {
  biToDate,
  Contracts,
  getContractAddress,
  getDelegationId,
  getWithdrawlId,
  reportException,
  updateIndexerCapacity,
  updateMaxUnstakeAmount,
  updateTotalDelegation,
  updateTotalLock,
  updateTotalStake,
  upsertEraValue,
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
  await updateIndexerStakeSummaryRemoved(event);
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

  const currEraIdx = await getCurrentEra();
  const currEraId = BigNumber.from(currEraIdx).toHexString();
  const nextEraId = BigNumber.from(currEraIdx + 1).toHexString();

  // update IndexerStakeSummary
  let indexerStakeSummary = await IndexerStakeSummary.get(indexer);

  let isFirstStake = false;
  if (
    !indexerStakeSummary ||
    getTotalStake(indexerStakeSummary, currEraId) === BigInt(0)
  ) {
    isFirstStake = true;
  }

  indexerStakeSummary = await updateIndexerStakeSummary(
    indexerStakeSummary,
    indexer,
    currEraId,
    isFirstStake,
    amountBn,
    source === indexer
  );

  // update IndexerStakeSummary for all indexers
  const allIndexerStakeSummary = await IndexerStakeSummary.get('0x00');

  await updateIndexerStakeSummary(
    allIndexerStakeSummary,
    '0x00',
    currEraId,
    isFirstStake,
    amountBn,
    source === indexer
  );

  // update IndexerState
  if (isFirstStake) {
    await IndexerStake.create({
      id: `${indexer}_${currEraId}`,
      eraId: currEraId,
      totalStake: amountBn,
      indexerStake: amountBn,
      delegatorStake: BigInt(0),
    }).save();
  } else {
    await IndexerStake.create({
      id: `${indexer}_${nextEraId}`,
      eraId: nextEraId,
      totalStake: indexerStakeSummary.nextTotalStake,
      indexerStake: indexerStakeSummary.nextIndexerStake,
      delegatorStake: indexerStakeSummary.nextDelegatorStake,
    }).save();
  }
}

function getTotalStake(
  summary: IndexerStakeSummary,
  currentEraId: string
): BigInt {
  if (summary.eraId === currentEraId) {
    return summary.totalStake;
  } else {
    return summary.nextTotalStake;
  }
}

async function updateIndexerStakeSummary(
  indexerStakeSummary: IndexerStakeSummary | undefined,
  indexer: string,
  currEraId: string,
  isFirstStake: boolean,
  amountBn: bigint,
  isIndexer: boolean
) {
  const newIndexerStake = isIndexer ? amountBn : BigInt(0);
  const newDelegatorStake = !isIndexer ? amountBn : BigInt(0);
  if (!indexerStakeSummary) {
    indexerStakeSummary = IndexerStakeSummary.create({
      id: indexer,
      eraId: currEraId,
      totalStake: BigInt(0),
      indexerStake: BigInt(0),
      delegatorStake: BigInt(0),
      nextTotalStake: BigInt(0),
      nextIndexerStake: BigInt(0),
      nextDelegatorStake: BigInt(0),
    });
  }

  if (isFirstStake) {
    indexerStakeSummary.eraId = currEraId;
    indexerStakeSummary.totalStake = amountBn;
    indexerStakeSummary.indexerStake = newIndexerStake;
    indexerStakeSummary.delegatorStake = newDelegatorStake;
    indexerStakeSummary.nextTotalStake = amountBn;
    indexerStakeSummary.nextIndexerStake = newIndexerStake;
    indexerStakeSummary.nextDelegatorStake = newDelegatorStake;
  } else if (indexerStakeSummary.eraId !== currEraId) {
    indexerStakeSummary.eraId = currEraId;
    indexerStakeSummary.totalStake = indexerStakeSummary.nextTotalStake;
    indexerStakeSummary.indexerStake = indexerStakeSummary.nextIndexerStake;
    indexerStakeSummary.delegatorStake = indexerStakeSummary.nextDelegatorStake;
    indexerStakeSummary.nextTotalStake += amountBn;
    indexerStakeSummary.nextIndexerStake += newIndexerStake;
    indexerStakeSummary.nextDelegatorStake += newDelegatorStake;
  } else {
    indexerStakeSummary.nextTotalStake += amountBn;
    indexerStakeSummary.nextIndexerStake += newIndexerStake;
    indexerStakeSummary.nextDelegatorStake += newDelegatorStake;
  }

  await indexerStakeSummary.save();
  return indexerStakeSummary;
}

async function removeFromIndexerStakeSummary(
  indexerStakeSummary: IndexerStakeSummary | undefined,
  indexer: string,
  currEraId: string,
  amountBn: bigint,
  isIndexer: boolean
) {
  if (!indexerStakeSummary) {
    indexerStakeSummary = IndexerStakeSummary.create({
      id: indexer,
      eraId: currEraId,
      totalStake: BigInt(0),
      indexerStake: BigInt(0),
      delegatorStake: BigInt(0),
      nextTotalStake: BigInt(0),
      nextIndexerStake: BigInt(0),
      nextDelegatorStake: BigInt(0),
    });
  }

  if (indexerStakeSummary.eraId !== currEraId) {
    indexerStakeSummary.eraId = currEraId;
    indexerStakeSummary.totalStake = indexerStakeSummary.nextTotalStake;
    indexerStakeSummary.indexerStake = indexerStakeSummary.nextIndexerStake;
    indexerStakeSummary.delegatorStake = indexerStakeSummary.nextDelegatorStake;
  }
  indexerStakeSummary.nextTotalStake -= amountBn;
  indexerStakeSummary.nextIndexerStake -= isIndexer ? amountBn : BigInt(0);
  indexerStakeSummary.nextDelegatorStake -= !isIndexer ? amountBn : BigInt(0);

  await indexerStakeSummary.save();
  return indexerStakeSummary;
}

async function updateIndexerStakeSummaryRemoved(
  event: EthereumLog<DelegationRemovedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { source, indexer, amount } = event.args;
  const amountBn = amount.toBigInt();

  const currEraIdx = await getCurrentEra();
  const currEraId = BigNumber.from(currEraIdx).toHexString();
  const nextEraIdx = currEraIdx + 1;
  const nextEraId = BigNumber.from(nextEraIdx).toHexString();

  // update IndexerStakeSummary

  let indexerStakeSummary = await IndexerStakeSummary.get(indexer);
  assert(indexerStakeSummary, `IndexerStakeSummary ${indexer} does not exist`);

  indexerStakeSummary = await removeFromIndexerStakeSummary(
    indexerStakeSummary,
    indexer,
    currEraId,
    amountBn,
    source === indexer
  );

  // update IndexerStakeSummary for all indexers

  const allIndexerStakeSummary = await IndexerStakeSummary.get('0x00');
  assert(
    allIndexerStakeSummary,
    `IndexerStakeSummary 0x00 for all indexers does not exist`
  );

  await removeFromIndexerStakeSummary(
    allIndexerStakeSummary,
    '0x00',
    currEraId,
    amountBn,
    source === indexer
  );

  // update IndexerState
  await IndexerStake.create({
    id: `${indexer}_${nextEraId}`,
    eraId: nextEraId,
    totalStake: indexerStakeSummary.nextTotalStake,
    indexerStake: indexerStakeSummary.nextIndexerStake,
    delegatorStake: indexerStakeSummary.nextDelegatorStake,
  }).save();
}
