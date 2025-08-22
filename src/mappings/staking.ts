// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Staking__factory } from '@subql/contract-sdk';
import {
  DelegationAddedEvent,
  DelegationAdded2Event,
  DelegationRemovedEvent,
  UnbondCancelledEvent,
  UnbondRequestedEvent,
  UnbondWithdrawnEvent,
} from '@subql/contract-sdk/typechain/contracts/Staking';
import assert from 'assert';
import {
  Delegation,
  EraDelegatorIndexer,
  EraIndexerDelegator,
  EraStake,
  EraStakeUpdate,
  Indexer,
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
  toBigInt,
  updateFlattenedDelegationFrom,
  updateFlattenedDelegationTo,
  updateFlattenedEraValue,
  updateIndexerCapacity,
  updateMaxUnstakeAmount,
  updateDelegatorDelegation,
  updateTotalLock,
  updateTotalStake,
  upsertEraValue,
} from './utils';
import { EthereumLog } from '@subql/types-ethereum';
import { CreateWithdrawlParams } from '../interfaces';
import { getWithdrawalType } from './utils/enumToTypes';
import { getCurrentEra } from './eraManager';
import { BigNumber } from 'ethers';
import { SetIndexerLeverageLimitTransaction } from '../types/abi-interfaces/Staking';
import { cacheGetBigNumber, CacheKey, cacheSet } from './utils/cache';

const { ONGOING, CLAIMED, CANCELLED } = WithdrawalStatus;

async function createOrUpdateWithdrawl({
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
  event: EthereumLog<DelegationAdded2Event['args']>
): Promise<void> {
  logger.info('handleAddDelegation');
  assert(event.args, 'No event args');

  const { source, runner, amount, instant } = event.args;
  const id = getDelegationId(source, runner);

  const amountBn = amount.toBigInt();
  let delegation = await Delegation.get(id);
  const selfStake = source === runner;
  const applyInstantly = (runner === source && !delegation) || instant;
  if (!selfStake) {
    await updateDelegatorDelegation(source, amountBn, 'add', applyInstantly);
  }

  await updateTotalStake(
    runner,
    amountBn,
    'add',
    event,
    selfStake,
    applyInstantly
  );

  if (!delegation) {
    // Indexers first stake is effective immediately
    const eraAmount = await upsertEraValue(
      undefined,
      amountBn,
      'add',
      applyInstantly
    );

    delegation = Delegation.create({
      id,
      delegatorId: source,
      indexerId: runner,
      amount: eraAmount,
      amountEra: eraAmount.era,
      amountEraValue: BigInt.fromJSONType(eraAmount.value),
      amountEraValueAfter: BigInt.fromJSONType(eraAmount.valueAfter),
      createdBlock: event.blockNumber,
    });
  } else {
    delegation.amount = await upsertEraValue(
      delegation.amount,
      amountBn,
      'add',
      applyInstantly
    );
    // Update flattened fields for delegation amount
    updateFlattenedEraValue(delegation, 'amount', delegation.amount);
  }

  if (BigInt.fromJSONType(delegation.amount.valueAfter) > BigInt(0)) {
    delegation.exitEra = undefined;
  }
  await updateTotalLock(amountBn, 'add', runner === source, event);
  await delegation.save();
  await updateIndexerCapacity(runner, event);
  await updateMaxUnstakeAmount(runner, event);
  await updateIndexerStakeSummaryAdded(event);
  if (applyInstantly) {
    await addToEraDelegation(
      delegation.amount.era,
      runner,
      source,
      amount.toBigInt()
    );
  } else {
    await addToEraDelegation(
      delegation.amount.era + 1,
      runner,
      source,
      amount.toBigInt()
    );
  }
}

export async function handleRemoveDelegation(
  event: EthereumLog<DelegationRemovedEvent['args']>
): Promise<void> {
  logger.info('handleRemoveDelegation');
  assert(event.args, 'No event args');

  const { source, runner, amount } = event.args;
  const id = getDelegationId(source, runner);
  const delegation = await Delegation.get(id);

  // Entity has already been removed when indexer unregisters
  if (!delegation) return;

  delegation.amount = await upsertEraValue(
    delegation.amount,
    amount.toBigInt(),
    'sub'
  );
  // Update flattened fields for delegation amount
  updateFlattenedEraValue(delegation, 'amount', delegation.amount);

  if (BigInt.fromJSONType(delegation.amount.valueAfter) === BigInt(0)) {
    delegation.exitEra = delegation.amount.era + 1;
  }

  const selfStake = source === runner;
  const applyInstantly = false;

  if (!selfStake) {
    await updateDelegatorDelegation(source, amount.toBigInt(), 'sub');
  }
  await updateTotalStake(
    runner,
    amount.toBigInt(),
    'sub',
    event,
    selfStake,
    applyInstantly
  );
  await updateTotalLock(amount.toBigInt(), 'sub', runner === source, event);

  await delegation.save();
  await updateIndexerCapacity(runner, event);
  await updateMaxUnstakeAmount(runner, event);
  await updateIndexerStakeSummaryRemoved(event);
  await removeFromEraDelegation(
    delegation.amount.era + 1,
    runner,
    source,
    amount.toBigInt()
  );
}

async function addToEraDelegation(
  era: number,
  indexer: string,
  delegator: string,
  amount: bigint
) {
  let indexerD = await EraIndexerDelegator.get(indexer);
  if (!indexerD) {
    indexerD = EraIndexerDelegator.create({
      id: indexer,
      indexer,
      era,
      delegators: [],
      delegatorAddresses: [],
      delegatorAmounts: [],
      totalStake: BigInt(0),
      selfStake: BigInt(0),
    });
  }
  const latestIndexerDEra = indexerD.era;
  indexerD.era = era;
  const delegationFrom = indexerD.delegators.find(
    (d) => d.delegator === delegator
  );
  if (delegationFrom) {
    logger.info(`Adding ${amount} to ${delegationFrom.amount}`);
    delegationFrom.amount = toBigInt(delegationFrom.amount.toString()) + amount;
  } else {
    indexerD.delegators.push({ delegator, amount });
  }
  // Update flattened fields for delegators
  updateFlattenedDelegationFrom(indexerD, indexerD.delegators);

  indexerD.totalStake += amount;
  if (indexer === delegator) {
    indexerD.selfStake += amount;
  }
  await indexerD.save();

  await fillUpEraIndexerDelegator(latestIndexerDEra, indexerD);

  let delegatorD = await EraDelegatorIndexer.get(delegator);
  if (!delegatorD) {
    delegatorD = EraDelegatorIndexer.create({
      id: delegator,
      delegator,
      era,
      indexers: [],
      indexerAddresses: [],
      indexerAmounts: [],
      totalStake: BigInt(0),
      selfStake: BigInt(0),
    });
  }
  const latestDelegatorDEra = delegatorD.era;
  delegatorD.era = era;
  const delegationTo = delegatorD.indexers.find((i) => i.indexer === indexer);
  if (delegationTo) {
    logger.info(`Adding ${amount} to ${delegationTo.amount}`);
    delegationTo.amount = toBigInt(delegationTo.amount.toString()) + amount;
  } else {
    delegatorD.indexers.push({ indexer, amount });
  }
  // Update flattened fields for indexers
  updateFlattenedDelegationTo(delegatorD, delegatorD.indexers);

  delegatorD.totalStake += amount;
  if (indexer === delegator) {
    delegatorD.selfStake += amount;
  }
  await delegatorD.save();

  await fillUpEraDelegatorIndexer(latestDelegatorDEra, delegatorD);
}

async function removeFromEraDelegation(
  era: number,
  indexer: string,
  delegator: string,
  amount: bigint
) {
  let indexerD = await EraIndexerDelegator.get(indexer);
  assert(indexerD, `Indexer ${indexer} not found in EraIndexerDelegator`);

  const latestIndexerDEra = indexerD.era;
  indexerD.era = era;
  indexerD.delegators = indexerD.delegators.map((d) => {
    if (d.delegator === delegator) {
      d.amount = toBigInt(d.amount.toString()) - amount;
    }
    return d;
  });
  indexerD.delegators = indexerD.delegators.filter(
    (d) => !(d.delegator === delegator && d.amount <= BigInt(0))
  );
  // Update flattened fields for delegators
  updateFlattenedDelegationFrom(indexerD, indexerD.delegators);

  indexerD.totalStake -= amount;
  if (indexer === delegator) {
    indexerD.selfStake -= amount;
  }
  await indexerD.save();

  await fillUpEraIndexerDelegator(latestIndexerDEra, indexerD);

  let delegatorD = await EraDelegatorIndexer.get(delegator);
  assert(delegatorD, `Delegator ${delegator} not found in EraDelegatorIndexer`);

  const latestDelegatorDEra = delegatorD.era;
  delegatorD.era = era;
  delegatorD.indexers = delegatorD.indexers.map((i) => {
    if (i.indexer === indexer) {
      i.amount = toBigInt(i.amount.toString()) - amount;
    }
    return i;
  });
  delegatorD.indexers = delegatorD.indexers.filter(
    (i) => !(i.indexer === indexer && i.amount <= BigInt(0))
  );
  // Update flattened fields for indexers
  updateFlattenedDelegationTo(delegatorD, delegatorD.indexers);

  delegatorD.totalStake -= amount;
  if (indexer === delegator) {
    delegatorD.selfStake -= amount;
  }
  await delegatorD.save();

  await fillUpEraDelegatorIndexer(latestDelegatorDEra, delegatorD);
}

async function fillUpEraIndexerDelegator(
  latestEra: number,
  indexerD: EraIndexerDelegator
) {
  let latestEraIndexerD = await EraIndexerDelegator.get(
    `${indexerD.indexer}:${BigNumber.from(latestEra).toHexString()}`
  );
  if (!latestEraIndexerD) {
    if (latestEra === indexerD.era) {
      latestEraIndexerD = EraIndexerDelegator.create({
        ...indexerD,
        id: `${indexerD.indexer}:${BigNumber.from(latestEra).toHexString()}`,
        delegators: indexerD.delegators,
        delegatorAddresses: indexerD.delegatorAddresses,
        delegatorAmounts: indexerD.delegatorAmounts,
      });
      await latestEraIndexerD.save();
    } else {
      throw new Error(
        `latest EraIndexerDelegator not found for ${
          indexerD.indexer
        }:${BigNumber.from(latestEra).toHexString()}`
      );
    }
  }

  for (let i = latestEra + 1; i < indexerD.era; i++) {
    await EraIndexerDelegator.create({
      ...latestEraIndexerD,
      era: i,
      id: `${indexerD.indexer}:${BigNumber.from(i).toHexString()}`,
      delegators: latestEraIndexerD.delegators,
    }).save();
  }

  await EraIndexerDelegator.create({
    ...indexerD,
    id: `${indexerD.indexer}:${BigNumber.from(indexerD.era).toHexString()}`,
    delegators: indexerD.delegators,
  }).save();
}

async function fillUpEraDelegatorIndexer(
  latestEra: number,
  delegatorD: EraDelegatorIndexer
) {
  let latestEraDelegatorD = await EraDelegatorIndexer.get(
    `${delegatorD.delegator}:${BigNumber.from(latestEra).toHexString()}`
  );
  if (!latestEraDelegatorD) {
    if (latestEra === delegatorD.era) {
      latestEraDelegatorD = EraDelegatorIndexer.create({
        ...delegatorD,
        id: `${delegatorD.delegator}:${BigNumber.from(
          latestEra
        ).toHexString()}`,
        indexers: delegatorD.indexers,
        indexerAddresses: delegatorD.indexerAddresses,
        indexerAmounts: delegatorD.indexerAmounts,
      });
      await latestEraDelegatorD.save();
    } else {
      throw new Error(
        `latest EraDelegatorIndexer not found for ${
          delegatorD.delegator
        }:${BigNumber.from(latestEra).toHexString()}`
      );
    }
  }

  for (let i = latestEra + 1; i < delegatorD.era; i++) {
    await EraDelegatorIndexer.create({
      ...latestEraDelegatorD,
      era: i,
      id: `${delegatorD.delegator}:${BigNumber.from(i).toHexString()}`,
      indexers: latestEraDelegatorD.indexers,
    }).save();
  }

  await EraDelegatorIndexer.create({
    ...delegatorD,
    id: `${delegatorD.delegator}:${BigNumber.from(
      delegatorD.era
    ).toHexString()}`,
    indexers: delegatorD.indexers,
  }).save();
}

export async function handleWithdrawRequested(
  event: EthereumLog<UnbondRequestedEvent['args']>
): Promise<void> {
  logger.info('handleWithdrawRequested');
  assert(event.args, 'No event args');

  const { source, runner, amount, index, _type } = event.args;
  const id = getWithdrawlId(source, index);

  let updatedAmount = amount;

  if (getWithdrawalType(_type) === WithdrawalType.MERGE) {
    const deleteRecord = await Withdrawl.get(id);
    assert(deleteRecord, `withdrawl record: ${id} not exist`);
    deleteRecord.id = `${deleteRecord.id}:${event.transactionHash}:${event.logIndex}`;
    deleteRecord.status = CANCELLED;
    deleteRecord.lastEvent = `handleWithdrawRequested: unbondReq merged to new one ${event.blockNumber}`;
    await deleteRecord.save();
    await Withdrawl.remove(id);
    updatedAmount = updatedAmount.add(deleteRecord.amount);
  }

  await createOrUpdateWithdrawl({
    id,
    delegator: source,
    indexer: runner,
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
  logger.info('handleWithdrawCancelled');
  assert(event.args, 'No event args');

  const { source, index } = event.args;
  const id = getWithdrawlId(source, index);
  const withdrawl = await Withdrawl.get(id);
  assert(withdrawl, `withdrawal record: ${id} not exist`);
  const deleteRecord = withdrawl;
  deleteRecord.id = `${withdrawl.id}:${event.transactionHash}:${event.logIndex}`;
  deleteRecord.status = CANCELLED;
  deleteRecord.lastEvent = `handleWithdrawCancelled:${event.blockNumber}`;
  await deleteRecord.save();
  await Withdrawl.remove(id);
}

async function updateIndexerStakeSummaryAdded(
  event: EthereumLog<DelegationAdded2Event['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { source, runner, amount, instant } = event.args;
  const amountBn = amount.toBigInt();

  const currEraIdx = await getCurrentEra();
  const currEraId = BigNumber.from(currEraIdx).toHexString();
  const nextEraIdx = currEraIdx + 1;
  const nextEraId = BigNumber.from(nextEraIdx).toHexString();

  // update IndexerStakeSummary
  let indexerStakeSummary = await IndexerStakeSummary.get(runner);

  let isFirstStake = false;
  if (
    !indexerStakeSummary ||
    getTotalStake(indexerStakeSummary, currEraId) === BigInt(0)
  ) {
    isFirstStake = true;
  }

  indexerStakeSummary = await updateIndexerStakeSummary(
    indexerStakeSummary,
    runner,
    currEraId,
    currEraIdx,
    isFirstStake,
    amountBn,
    source === runner,
    instant
  );

  // update IndexerStakeSummary for all indexers
  let allIndexerStakeSummary = await IndexerStakeSummary.get('0x00');

  allIndexerStakeSummary = await updateIndexerStakeSummary(
    allIndexerStakeSummary,
    '0x00',
    currEraId,
    currEraIdx,
    isFirstStake,
    amountBn,
    source === runner,
    instant
  );

  // update IndexerStake
  await updateIndexerStakeAdded(
    isFirstStake,
    runner,
    currEraId,
    currEraIdx,
    nextEraId,
    nextEraIdx,
    indexerStakeSummary,
    instant
  );

  // update EraStake
  await updateEraStakeAdd(
    isFirstStake,
    runner,
    source,
    currEraId,
    currEraIdx,
    nextEraId,
    nextEraIdx,
    amountBn,
    instant
  );

  // update IndexerStake for all indexers, sum by era
  await updateIndexerStakeAddedSumByEra(
    isFirstStake,
    currEraId,
    currEraIdx,
    nextEraId,
    nextEraIdx,
    allIndexerStakeSummary,
    instant
  );
}

async function updateIndexerStakeAdded(
  isFirstStake: boolean,
  indexer: string,
  currEraId: string,
  currEraIdx: number,
  nextEraId: string,
  nextEraIdx: number,
  indexerStakeSummary: IndexerStakeSummary,
  instant: boolean
) {
  if (isFirstStake || instant) {
    await IndexerStake.create({
      id: `${indexer}:${currEraId}`,
      indexerId: indexer,
      eraId: currEraId,
      eraIdx: currEraIdx,
      totalStake: indexerStakeSummary.totalStake,
      indexerStake: indexerStakeSummary.indexerStake,
      delegatorStake: indexerStakeSummary.delegatorStake,
    }).save();
  }
  await IndexerStake.create({
    id: `${indexer}:${nextEraId}`,
    indexerId: indexer,
    eraId: nextEraId,
    eraIdx: nextEraIdx,
    totalStake: indexerStakeSummary.nextTotalStake,
    indexerStake: indexerStakeSummary.nextIndexerStake,
    delegatorStake: indexerStakeSummary.nextDelegatorStake,
  }).save();
}

async function updateIndexerStakeAddedSumByEra(
  isFirstStake: boolean,
  currEraId: string,
  currEraIdx: number,
  nextEraId: string,
  nextEraIdx: number,
  allIndexerStakeSummary: IndexerStakeSummary,
  instant: boolean
) {
  if (isFirstStake || instant) {
    await IndexerStake.create({
      id: currEraId,
      indexerId: '0x00',
      eraId: currEraId,
      eraIdx: currEraIdx,
      totalStake: allIndexerStakeSummary.totalStake,
      indexerStake: allIndexerStakeSummary.indexerStake,
      delegatorStake: allIndexerStakeSummary.delegatorStake,
    }).save();
  }

  await IndexerStake.create({
    id: nextEraId,
    indexerId: '0x00',
    eraId: nextEraId,
    eraIdx: nextEraIdx,
    totalStake: allIndexerStakeSummary.nextTotalStake,
    indexerStake: allIndexerStakeSummary.nextIndexerStake,
    delegatorStake: allIndexerStakeSummary.nextDelegatorStake,
  }).save();
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
  currEraIdx: number,
  isFirstStake: boolean,
  amountBn: bigint,
  isIndexer: boolean,
  instant: boolean
) {
  // isIndexer: self stake
  const newIndexerStake = isIndexer ? amountBn : BigInt(0);
  const newDelegatorStake = !isIndexer ? amountBn : BigInt(0);
  if (!indexerStakeSummary) {
    indexerStakeSummary = IndexerStakeSummary.create({
      id: indexer,
      eraId: currEraId,
      eraIdx: currEraIdx,
      totalStake: BigInt(0),
      indexerStake: BigInt(0),
      delegatorStake: BigInt(0),
      nextTotalStake: BigInt(0),
      nextIndexerStake: BigInt(0),
      nextDelegatorStake: BigInt(0),
    });
  }

  const isCurrentEra = indexerStakeSummary.eraId === currEraId;

  if (isFirstStake || instant) {
    // for 0x00 indexer, record could be already existing even if it's first stake
    const exTotalStake = isCurrentEra
      ? indexerStakeSummary.totalStake
      : indexerStakeSummary.nextTotalStake;
    const exIndexerStake = isCurrentEra
      ? indexerStakeSummary.indexerStake
      : indexerStakeSummary.nextIndexerStake;
    const exDelegatorStake = isCurrentEra
      ? indexerStakeSummary.delegatorStake
      : indexerStakeSummary.nextDelegatorStake;
    indexerStakeSummary.eraId = currEraId;
    indexerStakeSummary.eraIdx = currEraIdx;
    indexerStakeSummary.totalStake = exTotalStake + amountBn;
    indexerStakeSummary.indexerStake = exIndexerStake + newIndexerStake;
    indexerStakeSummary.delegatorStake = exDelegatorStake + newDelegatorStake;
    indexerStakeSummary.nextTotalStake += amountBn;
    indexerStakeSummary.nextIndexerStake += newIndexerStake;
    indexerStakeSummary.nextDelegatorStake += newDelegatorStake;
  } else if (!isCurrentEra) {
    indexerStakeSummary.eraId = currEraId;
    indexerStakeSummary.eraIdx = currEraIdx;
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
  currEraIdx: number,
  amountBn: bigint,
  isIndexer: boolean
) {
  if (!indexerStakeSummary) {
    indexerStakeSummary = IndexerStakeSummary.create({
      id: indexer,
      eraId: currEraId,
      eraIdx: currEraIdx,
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
    indexerStakeSummary.eraIdx = currEraIdx;
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
  const { source, runner, amount } = event.args;
  const amountBn = amount.toBigInt();

  const currEraIdx = await getCurrentEra();
  const currEraId = BigNumber.from(currEraIdx).toHexString();
  const nextEraIdx = currEraIdx + 1;
  const nextEraId = BigNumber.from(nextEraIdx).toHexString();

  // update IndexerStakeSummary

  let indexerStakeSummary = await IndexerStakeSummary.get(runner);
  assert(indexerStakeSummary, `IndexerStakeSummary ${runner} does not exist`);

  indexerStakeSummary = await removeFromIndexerStakeSummary(
    indexerStakeSummary,
    runner,
    currEraId,
    currEraIdx,
    amountBn,
    source === runner
  );

  // update IndexerStakeSummary for all indexers

  let allIndexerStakeSummary = await IndexerStakeSummary.get('0x00');
  assert(
    allIndexerStakeSummary,
    `IndexerStakeSummary 0x00 for all indexers does not exist`
  );

  allIndexerStakeSummary = await removeFromIndexerStakeSummary(
    allIndexerStakeSummary,
    '0x00',
    currEraId,
    currEraIdx,
    amountBn,
    source === runner
  );

  // update IndexerStake
  await updateIndexerStakeRemoved(
    runner,
    nextEraId,
    nextEraIdx,
    indexerStakeSummary
  );

  // update EraStake
  await updateEraStakeRemove(runner, source, nextEraId, nextEraIdx, amountBn);

  // update IndexerStake for all indexers, sum by era
  await updateIndexerStakeRemovedSumByEra(
    nextEraId,
    nextEraIdx,
    allIndexerStakeSummary
  );
}

async function updateIndexerStakeRemoved(
  indexer: string,
  nextEraId: string,
  nextEraIdx: number,
  indexerStakeSummary: IndexerStakeSummary
) {
  await IndexerStake.create({
    id: `${indexer}:${nextEraId}`,
    indexerId: indexer,
    eraId: nextEraId,
    eraIdx: nextEraIdx,
    totalStake: indexerStakeSummary.nextTotalStake,
    indexerStake: indexerStakeSummary.nextIndexerStake,
    delegatorStake: indexerStakeSummary.nextDelegatorStake,
  }).save();
}

async function updateIndexerStakeRemovedSumByEra(
  nextEraId: string,
  nextEraIdx: number,
  allIndexerStakeSummary: IndexerStakeSummary
) {
  await IndexerStake.create({
    id: `${nextEraId}`,
    indexerId: '0x00',
    eraId: nextEraId,
    eraIdx: nextEraIdx,
    totalStake: allIndexerStakeSummary.nextTotalStake,
    indexerStake: allIndexerStakeSummary.nextIndexerStake,
    delegatorStake: allIndexerStakeSummary.nextDelegatorStake,
  }).save();
}

async function updateEraStakeAdd(
  isFirstStake: boolean,
  indexer: string,
  delegator: string,
  currEraId: string,
  currEraIdx: number,
  nextEraId: string,
  nextEraIdx: number,
  amountBn: bigint,
  instant: boolean
) {
  if (isFirstStake || instant) {
    const currEraStakeId = `${indexer}:${delegator}:${currEraId}`;
    await updateEraStake(
      currEraStakeId,
      indexer,
      delegator,
      currEraId,
      currEraIdx,
      amountBn
    );
  }
  const nextEraStakeId = `${indexer}:${delegator}:${nextEraId}`;
  await updateEraStake(
    nextEraStakeId,
    indexer,
    delegator,
    nextEraId,
    nextEraIdx,
    amountBn,
    instant
  );
}

async function updateEraStakeRemove(
  indexer: string,
  delegator: string,
  nextEraId: string,
  nextEraIdx: number,
  amountBn: bigint
) {
  const nextEraStakeId = `${indexer}:${delegator}:${nextEraId}`;
  await updateEraStake(
    nextEraStakeId,
    indexer,
    delegator,
    nextEraId,
    nextEraIdx,
    BigInt(0) - amountBn
  );
}

async function updateEraStake(
  eraStakeId: string,
  indexer: string,
  delegator: string,
  eraId: string,
  eraIdx: number,
  amountBn: bigint,
  instant?: boolean
) {
  let eraStake = await EraStake.get(eraStakeId);
  if (!eraStake) {
    const lastStakeAmountBn = await getLastStakeAmount(
      indexer,
      delegator,
      eraId
    );
    eraStake = await EraStake.create({
      id: eraStakeId,
      indexerId: indexer,
      delegatorId: delegator,
      eraId,
      eraIdx,
      stake: instant ? lastStakeAmountBn : lastStakeAmountBn + amountBn,
    });
  } else {
    eraStake.stake += amountBn;
  }
  await eraStake.save();
}

async function getLastStakeAmount(
  indexer: string,
  delegator: string,
  eraId: string
): Promise<bigint> {
  let lastStakeAmountBn = BigInt(0);

  const updateRecordId = `${indexer}:${delegator}`;
  let updateRecord = await EraStakeUpdate.get(updateRecordId);
  if (!updateRecord) {
    updateRecord = EraStakeUpdate.create({
      id: updateRecordId,
      lastUpdateEraId: eraId,
    });
  } else {
    assert(eraId !== updateRecord.lastUpdateEraId);

    const lastStakeId = `${indexer}:${delegator}:${updateRecord.lastUpdateEraId}`;
    lastStakeAmountBn =
      (await EraStake.get(lastStakeId))?.stake ?? lastStakeAmountBn;
    updateRecord.lastUpdateEraId = eraId;
  }
  await updateRecord.save();

  return lastStakeAmountBn;
}

export async function getIndexerLeverageLimit(): Promise<BigNumber> {
  let indexerLeverageLimit = await cacheGetBigNumber(
    CacheKey.IndexerLeverageLimit
  );
  if (indexerLeverageLimit === undefined) {
    indexerLeverageLimit = await updateIndexerLeverageLimit();
  }
  return indexerLeverageLimit;
}

async function updateIndexerLeverageLimit() {
  const network = await api.getNetwork();
  const staking = Staking__factory.connect(
    getContractAddress(network.chainId, Contracts.STAKING_ADDRESS),
    api
  );
  const indexerLeverageLimit = await staking.indexerLeverageLimit();
  await cacheSet(
    CacheKey.IndexerLeverageLimit,
    indexerLeverageLimit.toString()
  );
  return indexerLeverageLimit;
}

export async function handleSetIndexerLeverageLimit(
  tx: SetIndexerLeverageLimitTransaction
): Promise<void> {
  const receipt = await tx.receipt();
  if (receipt.status) {
    const amount = tx.args?.[0] as BigNumber;
    await cacheSet(CacheKey.IndexerLeverageLimit, amount.toString());
  }
}

export async function handleBlock_12750283(): Promise<void> {
  const indexerLeverageLimit = await updateIndexerLeverageLimit();
  logger.info(
    `IndexerLeverageLimit updated: ${indexerLeverageLimit.toString()}`
  );
}
