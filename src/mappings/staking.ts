// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import {
  EraManager,
  EraManager__factory,
  Staking__factory,
} from '@subql/contract-sdk';
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
  StakeSummary,
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
  getCurrentEra,
} from './utils';
import { EthereumLog } from '@subql/types-ethereum';
import { CreateWithdrawlParams } from '../interfaces';
import { getWithdrawalType } from './utils/enumToTypes';

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
  const network = await api.getNetwork();
  const eraManager = EraManager__factory.connect(
    getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
    api
  );

  const amountBn = amount.toBigInt();
  let delegation = await Delegation.get(id);

  await updateTotalDelegation(
    eraManager,
    source,
    amountBn,
    'add',
    indexer === source && !delegation
  );

  await updateTotalStake(
    eraManager,
    indexer,
    amountBn,
    'add',
    event,
    indexer === source && !delegation
  );

  if (!delegation) {
    // Indexers first stake is effective immediately
    const eraAmount = await upsertEraValue(
      eraManager,
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
    delegation.amount = await upsertEraValue(
      eraManager,
      delegation.amount,
      amountBn
    );
  }

  if (BigInt.fromJSONType(delegation.amount.valueAfter) > BigInt(0)) {
    delegation.exitEra = undefined;
  }
  await updateTotalLock(eraManager, amountBn, 'add', indexer === source, event);
  await delegation.save();
  await updateIndexerCapacity(indexer, event);
  await updateMaxUnstakeAmount(indexer, event);
  await updateStakeSummary(event, eraManager);
}

export async function handleRemoveDelegation(
  event: EthereumLog<DelegationRemovedEvent['args']>
): Promise<void> {
  logger.info('handleRemoveDelegation');
  assert(event.args, 'No event args');

  const { source, indexer, amount } = event.args;
  const id = getDelegationId(source, indexer);
  const network = await api.getNetwork();
  const eraManager = EraManager__factory.connect(
    getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
    api
  );

  const delegation = await Delegation.get(id);

  // Entity has already been removed when indexer unregisters
  if (!delegation) return;

  delegation.amount = await upsertEraValue(
    eraManager,
    delegation.amount,
    amount.toBigInt(),
    'sub'
  );

  if (BigInt.fromJSONType(delegation.amount.valueAfter) === BigInt(0)) {
    delegation.exitEra = delegation.amount.era + 1;
  }

  await updateTotalDelegation(eraManager, source, amount.toBigInt(), 'sub');
  await updateTotalStake(eraManager, indexer, amount.toBigInt(), 'sub', event);
  await updateTotalLock(
    eraManager,
    amount.toBigInt(),
    'sub',
    indexer === source,
    event
  );

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

async function updateStakeSummary(
  event: EthereumLog<DelegationAddedEvent['args']>,
  eraManager: EraManager | null
): Promise<void> {
  assert(event.args, 'No event args');
  const { source, indexer, amount } = event.args;
  const amountBn = amount.toBigInt();

  const indexerEntity = await Indexer.get(indexer);
  assert(indexerEntity, `Indexer ${indexer} does not exist`);
  // const isFirstStake =
  //   BigInt.fromJSONType(indexerEntity.totalStake.value) === BigInt(0);

  let indexerStake = BigInt(0);
  let delegatorStake = BigInt(0);

  if (source === indexer) {
    indexerStake += amountBn;
  } else {
    delegatorStake += amountBn;
  }

  const eraIdx = await getCurrentEra(eraManager);
  const eraId = eraIdx.toString();
  // const prevEraIdx = eraIdx - 1;
  const prevEraId = (eraIdx - 1).toString();
  const nextEraIdx = eraIdx + 1;
  const nextEraId = nextEraIdx.toString();

  const isFirstStake = !!(await StakeSummary.get(prevEraId));

  if (isFirstStake) {
    let currentStakeSummary = await StakeSummary.get(eraId);
    if (!currentStakeSummary) {
      currentStakeSummary = StakeSummary.create({
        id: eraId,
        totalStake: amountBn,
        indexerStake,
        delegatorStake,
      });
    } else {
      currentStakeSummary.totalStake += amountBn;
      currentStakeSummary.indexerStake += indexerStake;
      currentStakeSummary.delegatorStake += delegatorStake;
    }
    await currentStakeSummary.save();
  }

  // let currentStakeSummary = await StakeSummary.get(eraId);
  // if (!currentStakeSummary) {
  //   currentStakeSummary = StakeSummary.create({
  //     id: eraId,
  //     totalStake: BigInt(0),
  //     indexerStake: BigInt(0),
  //     delegatorStake: BigInt(0),
  //   });
  // }
  // await currentStakeSummary.save();

  let nextStakeSummary = await StakeSummary.get(nextEraId);
  if (!nextStakeSummary) {
    nextStakeSummary = StakeSummary.create({
      id: nextEraId,
      totalStake: amountBn,
      indexerStake,
      delegatorStake,
    });
  } else {
    nextStakeSummary.totalStake += amountBn;
    nextStakeSummary.indexerStake += indexerStake;
    nextStakeSummary.delegatorStake += delegatorStake;
  }
  await nextStakeSummary.save();
}
