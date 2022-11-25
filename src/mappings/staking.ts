// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import {
  EraManager__factory,
  IndexerRegistry__factory,
  Staking__factory,
} from '@subql/contract-sdk';
import {
  DelegationAddedEvent,
  DelegationRemovedEvent,
  UnbondRequestedEvent,
  UnbondWithdrawnEvent,
  UnbondCancelledEvent,
  SetCommissionRateEvent,
} from '@subql/contract-sdk/typechain/Staking';
import assert from 'assert';
import { Delegation, Withdrawl, Indexer, WithdrawalStatus } from '../types';
import FrontierEthProvider from './ethProvider';
import {
  ERA_MANAGER_ADDRESS,
  updateTotalStake,
  upsertEraValue,
  updateTotalDelegation,
  reportException,
  updateTotalLock,
  updateIndexerCapacity,
  getWithdrawlId,
  getDelegationId,
  STAKING_ADDRESS,
  reportIndexerNonExistException,
  min,
} from './utils';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';
import { createIndexer } from './utils';
import { CreateWithdrawlParams } from '../interfaces';
import { BigNumber } from 'ethers';

const { ONGOING, CLAIMED, CANCELLED } = WithdrawalStatus;

async function createWithdrawl({
  id,
  delegator,
  indexer,
  index,
  amount,
  status,
  event,
}: CreateWithdrawlParams): Promise<void> {
  const { blockTimestamp, blockNumber } = event;
  const withdrawl = Withdrawl.create({
    id,
    delegator: delegator,
    indexer: indexer,
    index: index.toBigInt(),
    startTime: blockTimestamp,
    amount: amount.toBigInt(),
    status,
    createdBlock: blockNumber,
  });

  await withdrawl.save();
}

async function updateMaxUnstakeAmount(
  indexerAddress: string,
  event: FrontierEvmEvent
): Promise<void> {
  const staking = Staking__factory.connect(
    STAKING_ADDRESS,
    new FrontierEthProvider()
  );
  const indexerRegistry = IndexerRegistry__factory.connect(
    STAKING_ADDRESS,
    new FrontierEthProvider()
  );

  const leverageLimit = await staking.indexerLeverageLimit();
  const minStakingAmount = await indexerRegistry.minimumStakingAmount();

  const indexer = await Indexer.get(indexerAddress);

  if (indexer) {
    const { totalStake } = indexer;

    const delegationId = getDelegationId(indexerAddress, indexerAddress);
    const { amount: ownStake } = (await Delegation.get(delegationId)) || {};

    const totalStakingAmountAfter = BigNumber.from(
      totalStake.valueAfter.value ?? 0
    );
    const ownStakeAfter = BigNumber.from(ownStake?.valueAfter.value ?? 0);

    if (leverageLimit.eq(1)) {
      indexer.maxUnstakeAmount = ownStakeAfter.sub(minStakingAmount).toBigInt();
    } else {
      const maxUnstakeAmount = min(
        ownStakeAfter.sub(minStakingAmount),
        ownStakeAfter
          .mul(leverageLimit)
          .sub(totalStakingAmountAfter)
          .div(leverageLimit.sub(1))
      );

      indexer.maxUnstakeAmount = (
        maxUnstakeAmount.isNegative() ? BigNumber.from(0) : maxUnstakeAmount
      ).toBigInt();
    }

    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'updateMaxUnstakeAmount',
      indexerAddress,
      event
    );
  }
}

export async function handleAddDelegation(
  event: FrontierEvmEvent<DelegationAddedEvent['args']>
): Promise<void> {
  logger.info('handleAddDelegation');
  assert(event.args, 'No event args');

  const { source, indexer, amount } = event.args;
  const id = getDelegationId(source, indexer);
  const eraManager = EraManager__factory.connect(
    ERA_MANAGER_ADDRESS,
    new FrontierEthProvider()
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

    await updateTotalStake(
      eraManager,
      indexer,
      amountBn,
      'add',
      event,
      indexer === source
    );
  } else {
    delegation.amount = await upsertEraValue(
      eraManager,
      delegation.amount,
      amountBn
    );

    await updateTotalStake(eraManager, indexer, amountBn, 'add', event);
  }

  await updateTotalLock(eraManager, amountBn, 'add', indexer === source, event);
  await delegation.save();
  await updateIndexerCapacity(indexer, event);
  await updateMaxUnstakeAmount(indexer, event);
}

export async function handleRemoveDelegation(
  event: FrontierEvmEvent<DelegationRemovedEvent['args']>
): Promise<void> {
  logger.info('handleRemoveDelegation');
  assert(event.args, 'No event args');

  const { source, indexer, amount } = event.args;
  const id = getDelegationId(source, indexer);
  const eraManager = EraManager__factory.connect(
    ERA_MANAGER_ADDRESS,
    new FrontierEthProvider()
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
  event: FrontierEvmEvent<UnbondRequestedEvent['args']>
): Promise<void> {
  logger.info('handleWithdrawRequested');
  assert(event.args, 'No event args');

  const { source, indexer, index, amount } = event.args;
  const id = getWithdrawlId(source, index);

  await createWithdrawl({
    id,
    delegator: source,
    indexer,
    index,
    amount,
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
  event: FrontierEvmEvent<UnbondWithdrawnEvent['args']>
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
  event: FrontierEvmEvent<UnbondCancelledEvent['args']>
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

export async function handleSetCommissionRate(
  event: FrontierEvmEvent<SetCommissionRateEvent['args']>
): Promise<void> {
  logger.info('handleSetCommissionRate');
  assert(event.args, 'No event args');

  const address = event.args.indexer;
  const eraManager = EraManager__factory.connect(
    ERA_MANAGER_ADDRESS,
    new FrontierEthProvider()
  );

  const lastEvent = `handleSetCommissionRate:${event.blockNumber}`;
  let indexer = await Indexer.get(address);

  if (!indexer) {
    indexer = await createIndexer({
      address,
      active: true,
      lastEvent,
      createdBlock: event.blockNumber,
    });
  }

  indexer.commission = await upsertEraValue(
    eraManager,
    indexer.commission,
    event.args.amount.toBigInt(),
    'replace',
    // Apply instantly when era is -1, this is an indication that indexer has just registered
    indexer.commission.era === -1
  );
  indexer.lastEvent = `handleSetCommissionRate:${event.blockNumber}`;

  await indexer.save();
}
