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
} from './utils';
import { EthereumLog } from '@subql/types-ethereum';
import { CreateWithdrawlParams } from '../interfaces';
import { getWithdrawalType } from './utils/enumToTypes';
import { getCurrentEra } from './eraManager';

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
  await updateStakeSummary(event);
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

async function updateStakeSummary(
  event: EthereumLog<DelegationAddedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { source, indexer, amount } = event.args;
  const amountBn = amount.toBigInt();

  try {
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
    const currEraId = currEraIdx.toString(16);
    const prevEraIdx = currEraIdx - 1;
    const prevEraId = prevEraIdx.toString(16);
    const nextEraIdx = currEraIdx + 1;
    const nextEraId = nextEraIdx.toString(16);

    // FIXME - there is possibility that the indexer would quit and join stake at the same era (or at the next era), which would make some mistake in the current era and the next era
    const isFirstStake =
      !(await StakeSummary.get(prevEraId)) &&
      !(await StakeSummary.get(currEraId));

    if (isFirstStake) {
      const currentStakeSummary = StakeSummary.create({
        id: currEraId,
        totalStake: amountBn,
        indexerStake: newIndexerStake,
        delegatorStake: newDelegatorStake,
      });
      await currentStakeSummary.save();
    }

    let nextStakeSummary = await StakeSummary.get(nextEraId);
    if (!nextStakeSummary) {
      nextStakeSummary = StakeSummary.create({
        id: nextEraId,
        totalStake: amountBn,
        indexerStake: newIndexerStake,
        delegatorStake: newDelegatorStake,
      });
    } else {
      nextStakeSummary.totalStake += amountBn;
      nextStakeSummary.indexerStake += newIndexerStake;
      nextStakeSummary.delegatorStake += newDelegatorStake;
    }
    await nextStakeSummary.save();
  } catch (e) {
    logger.error('Error: updateStakeSummary', e);
  }
}
