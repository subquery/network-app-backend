// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  Delegation,
  IndexerReward,
  Indexer,
  Reward,
  UnclaimedReward,
} from '../types';
import { RewardsDistributer__factory } from '@subql/contract-sdk';
import FrontierEthProvider from './ethProvider';
import {
  ClaimRewardsEvent,
  DistributeRewardsEvent,
  RewardsChangedEvent,
} from '@subql/contract-sdk/typechain/RewardsDistributer';
import { REWARD_DIST_ADDRESS } from './utils';
import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import { BigNumber } from '@ethersproject/bignumber';

function buildRewardId(indexer: string, delegator: string): string {
  return `${indexer}:${delegator}`;
}

function getIndexerRewardId(indexer: string, eraIdx: BigNumber): string {
  return `${indexer}:${eraIdx.toHexString()}`;
}

function getPrevIndexerRewardId(indexer: string, eraIdx: BigNumber): string {
  return getIndexerRewardId(indexer, eraIdx.sub(1));
}

export async function handleRewardsDistributed(
  event: AcalaEvmEvent<DistributeRewardsEvent['args']>
): Promise<void> {
  logger.info('handleRewardsDistributed');
  assert(event.args, 'No event args');

  const { indexer } = event.args;
  const delegators = await Delegation.getByIndexerId(indexer);
  if (!delegators) return;

  const rewardsDistributor = RewardsDistributer__factory.connect(
    REWARD_DIST_ADDRESS,
    new FrontierEthProvider()
  );

  await Promise.all(
    delegators.map(async (delegator) => {
      const rewards = await rewardsDistributor.userRewards(
        indexer,
        delegator.delegatorId
      );
      const id = buildRewardId(indexer, delegator.delegatorId);

      let reward = await UnclaimedReward.get(id);

      if (!reward) {
        reward = UnclaimedReward.create({
          id,
          delegatorAddress: delegator.delegatorId,
          indexerAddress: indexer,
          amount: rewards.toBigInt(),
        });
      } else {
        reward.amount = rewards.toBigInt();
      }

      await reward.save();
    })
  );
}

export async function handleRewardsClaimed(
  event: AcalaEvmEvent<ClaimRewardsEvent['args']>
): Promise<void> {
  logger.info('handleRewardsClaimed');
  assert(event.args, 'No event args');

  const id = buildRewardId(event.args.indexer, event.args.delegator);

  const unclaimed = await UnclaimedReward.get(id);

  assert(
    event.args.rewards.isZero() ||
      unclaimed?.amount === event.args.rewards.toBigInt(),
    `unclaimed reward doesn't match claimed reward ${
      unclaimed?.amount
    } ${event.args.rewards.toBigInt()}`
  );

  await UnclaimedReward.remove(id);

  const reward = Reward.create({
    id: `${id}:${event.transactionHash}`,
    indexerAddress: event.args.indexer,
    delegatorAddress: event.args.delegator,
    amount: event.args.rewards.toBigInt(),
    claimedTime: event.blockTimestamp,
  });

  await reward.save();

  // throw new Error('DONE')
}

export async function handleRewardsUpdated(
  event: AcalaEvmEvent<RewardsChangedEvent['args']>
): Promise<void> {
  logger.info('handleRewardsUpdated');
  assert(event.args, 'No event args');

  const { indexer, eraIdx, additions, removals } = event.args;
  const id = getIndexerRewardId(indexer, eraIdx);

  const prevEraRewards = await IndexerReward.get(
    getPrevIndexerRewardId(indexer, eraIdx)
  );
  const prevAmount = prevEraRewards?.amount ?? BigInt(0);

  let eraRewards = await IndexerReward.get(id);

  if (!eraRewards) {
    eraRewards = IndexerReward.create({
      id,
      indexerId: indexer,
      eraIdx: eraIdx.toHexString(),
      additions: additions.toBigInt(),
      removals: removals.toBigInt(),
      amount: BigInt(0), // Updated below
    });
  } else {
    eraRewards.additions = additions.toBigInt();
    eraRewards.removals = removals.toBigInt();
  }

  eraRewards.amount = prevAmount + additions.toBigInt() - removals.toBigInt();

  await eraRewards.save();

  const lastEraIdx = await upsertIndexerLastRewardEra(indexer, eraIdx);

  /* Rewards changed events don't come in in order and may not be the latest set era */
  await updateFutureRewards(indexer, lastEraIdx, eraRewards);
}

async function upsertIndexerLastRewardEra(
  indexerAddress: string,
  eraIdx: BigNumber
): Promise<BigNumber> {
  const indexer = await Indexer.get(indexerAddress);

  assert(indexer, "Indexer Doesn't exist");

  const lastRewardedEra = indexer.lastRewardedEra
    ? BigNumber.from(indexer.lastRewardedEra)
    : undefined;

  if (!lastRewardedEra || lastRewardedEra.lt(eraIdx)) {
    indexer.lastRewardedEra = eraIdx.toHexString();

    await indexer.save();

    return eraIdx;
  } else {
    return lastRewardedEra;
  }
}

async function updateFutureRewards(
  indexer: string,
  lastRewardedEra: BigNumber,
  prevEraRewards: Readonly<IndexerReward>
) {
  const eraRewards: IndexerReward[] = [];

  let prev = prevEraRewards;
  let prevEraId = BigNumber.from(prevEraRewards.eraIdx);

  // Recalc all rewards until we get to the lastRewardedEra
  while (prevEraId.lte(lastRewardedEra)) {
    const eraId = BigNumber.from(prev.eraIdx).add(1);
    const id = getIndexerRewardId(indexer, eraId);

    let eraReward = await IndexerReward.get(id);

    if (!eraReward) {
      eraReward = IndexerReward.create({
        id,
        indexerId: indexer,
        // eraId: eraId.toHexString(),
        eraIdx: eraId.toHexString(),
        additions: BigInt(0),
        removals: BigInt(0),
        amount: prev.amount,
      });

      eraRewards.push(eraReward);
    } else {
      eraReward.amount = prev.amount + eraReward.additions - eraReward.removals;

      await eraReward.save();
    }

    prev = eraReward;
    prevEraId = eraId;
  }

  await store.bulkCreate('IndexerReward', eraRewards);
}
