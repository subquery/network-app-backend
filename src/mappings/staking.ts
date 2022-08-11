// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { EraManager__factory } from '@subql/contract-sdk';
import {
  DelegationAddedEvent,
  DelegationRemovedEvent,
  UnbondRequestedEvent,
  UnbondWithdrawnEvent,
  SetCommissionRateEvent,
} from '@subql/contract-sdk/typechain/Staking';
import assert from 'assert';
import { Delegation, Withdrawl, Indexer } from '../types';
import FrontierEthProvider from './ethProvider';
import {
  ERA_MANAGER_ADDRESS,
  updateTotalStake,
  upsertEraValue,
  updateTotalDelegation,
  reportException,
} from './utils';
import { BigNumber } from '@ethersproject/bignumber';
import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import { CreateWithdrawlParams } from '../customTypes';

function getDelegationId(delegator: string, indexer: string): string {
  return `${delegator}:${indexer}`;
}

function getWithdrawlId(delegator: string, index: BigNumber): string {
  return `${delegator}:${index.toHexString()}`;
}

async function createWithdrawl({
  id,
  delegator,
  indexer,
  index,
  amount,
  claimed,
  event,
}: CreateWithdrawlParams): Promise<void> {
  const withdrawl = Withdrawl.create({
    id,
    delegator: delegator,
    indexer: indexer,
    index: index.toBigInt(),
    startTime: event.blockTimestamp,
    amount: amount.toBigInt(),
    claimed,
    createdBlock: event.blockNumber,
  });

  await withdrawl.save();
}

export async function handleAddDelegation(
  event: AcalaEvmEvent<DelegationAddedEvent['args']>
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
      indexer === source
    );
  } else {
    delegation.amount = await upsertEraValue(
      eraManager,
      delegation.amount,
      amountBn
    );

    await updateTotalStake(eraManager, indexer, amountBn, 'add');
  }

  await delegation.save();
}

export async function handleRemoveDelegation(
  event: AcalaEvmEvent<DelegationRemovedEvent['args']>
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

  // assert(delegation, `Expected delegation (${id}) to exist`);

  delegation.amount = await upsertEraValue(
    eraManager,
    delegation.amount,
    amount.toBigInt(),
    'sub'
  );

  await updateTotalDelegation(eraManager, source, amount.toBigInt(), 'sub');
  await updateTotalStake(eraManager, indexer, amount.toBigInt(), 'sub');

  await delegation.save();
}

export async function handleWithdrawRequested(
  event: AcalaEvmEvent<UnbondRequestedEvent['args']>
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
    claimed: false,
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
  event: AcalaEvmEvent<UnbondWithdrawnEvent['args']>
): Promise<void> {
  logger.info('handleWithdrawClaimed');
  assert(event.args, 'No event args');

  const { source, index, amount } = event.args;
  const id = getWithdrawlId(source, index);

  const withdrawl = await Withdrawl.get(id);

  if (withdrawl) {
    withdrawl.claimed = true;
    withdrawl.lastEvent = `handleWithdrawClaimed:${event.blockNumber}`;

    await withdrawl.save();
  } else {
    await createWithdrawl({
      id,
      delegator: source,
      indexer: '-',
      index,
      amount,
      claimed: true,
      event,
    });

    logger.warn(`Force upsert: Expected withdrawl ${id} to exist.`);
    const exception = `Expected withdrawl ${id} to exist: ${JSON.stringify(
      event
    )}`;

    await reportException(
      'handleWithdrawClaimed',
      event.logIndex,
      event.blockNumber,
      exception
    );
  }
}

export async function handleWithdrawCancelled(
  event: AcalaEvmEvent<UnbondCancelledEvent['args']>
): Promise<void> {
  const { source, indexer, amount, index } = event.args;
  const id = getWithdrawlId(source, index);
  const withdrawl = await Withdrawl.get(id);

  if (withdrawl) {
    withdrawl.lastEvent = `handleWithdrawCancelled:${event.blockNumber}`;
    await withdrawl.save();
  } else {
    await createWithdrawl({
      id,
      delegator: source,
      indexer,
      index,
      amount,
      claimed: false,
      event,
    });

    logger.warn(`Force upsert: Expected withdrawl ${id} to exist.`);
    const exception = `Expected withdrawl ${id} to exist: ${JSON.stringify(
      event
    )}`;

    await reportException(
      'handleWithdrawCancelled',
      event.logIndex,
      event.blockNumber,
      exception
    );
  }
}

export async function handleSetCommissionRate(
  event: AcalaEvmEvent<SetCommissionRateEvent['args']>
): Promise<void> {
  logger.info('handleSetCommissionRate');
  assert(event.args, 'No event args');

  const address = event.args.indexer;
  const eraManager = EraManager__factory.connect(
    ERA_MANAGER_ADDRESS,
    new FrontierEthProvider()
  );

  let indexer = await Indexer.get(address);

  if (!indexer) {
    indexer = Indexer.create({
      id: address,
      metadata: '',
      totalStake: {
        era: -1,
        value: BigInt(0).toJSONType(),
        valueAfter: BigInt(0).toJSONType(),
      },
      commission: {
        era: -1,
        value: BigInt(0).toJSONType(),
        valueAfter: BigInt(0).toJSONType(),
      },
      active: true,
      createdBlock: event.blockNumber,
    });

    indexer;
  }

  // assert(indexer, `Expected indexer (${address}) to exist`);

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
