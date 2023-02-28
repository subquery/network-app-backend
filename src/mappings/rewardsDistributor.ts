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
import {
  ClaimRewardsEvent,
  DistributeRewardsEvent,
  RewardsChangedEvent,
} from '@subql/contract-sdk/typechain/RewardsDistributer';
import { biToDate, REWARD_DIST_ADDRESS } from './utils';
import { EthereumLog } from '@subql/types-ethereum';

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
  event: EthereumLog<DistributeRewardsEvent['args']>
): Promise<void> {
  logger.info('handleRewardsDistributed');
  assert(event.args, 'No event args');

  const { indexer } = event.args;
  const delegators = await Delegation.getByIndexerId(indexer);
  if (!delegators) return;

  const rewardsDistributor = RewardsDistributer__factory.connect(
    REWARD_DIST_ADDRESS,
    api
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
          createdBlock: event.blockNumber,
        });
      } else {
        reward.amount = rewards.toBigInt();
        reward.lastEvent = `handleRewardsDistributed:${event.blockNumber}`;
      }

      await reward.save();
    })
  );
}

export async function handleRewardsClaimed(
  event: EthereumLog<ClaimRewardsEvent['args']>
): Promise<void> {
  logger.info('handleRewardsClaimed');
  assert(event.args, 'No event args');

  const id = buildRewardId(event.args.indexer, event.args.delegator);

  // FIXME: need to investigate this issue in the future
  // FIXME: unclaimed?.amount NOT EQUAL event.args.rewards.toBigInt(),
  // const unclaimed = await UnclaimedReward.get(id);
  // assert(
  //   event.args.rewards.isZero() ||
  //     unclaimed?.amount === event.args.rewards.toBigInt(),
  //   `unclaimed reward doesn't match claimed reward ${
  //     unclaimed?.amount
  //   } ${event.args.rewards.toBigInt()}`
  // );

  try {
    await UnclaimedReward.remove(id);

    const reward = Reward.create({
      id: `${id}:${event.transactionHash}`,
      indexerAddress: event.args.indexer,
      delegatorAddress: event.args.delegator,
      amount: event.args.rewards.toBigInt(),
      claimedTime: biToDate(event.block.timestamp),
      createdBlock: event.blockNumber,
    });

    await reward.save();
  } catch {
    logger.error(`ERROR: handleRewardsClaimed`);
  }
}

export async function handleRewardsUpdated(
  event: EthereumLog<RewardsChangedEvent['args']>
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
      createdBlock: event.blockNumber,
    });
  } else {
    eraRewards.additions = additions.toBigInt();
    eraRewards.removals = removals.toBigInt();
    eraRewards.lastEvent = `handleRewardsUpdated:${event.blockNumber}`;
  }

  eraRewards.amount = prevAmount + additions.toBigInt() - removals.toBigInt();

  await eraRewards.save();

  const lastEraIdx = await upsertIndexerLastRewardEra(
    indexer,
    eraIdx,
    event.blockNumber
  );

  /* Rewards changed events don't come in in order and may not be the latest set era */
  await updateFutureRewards(indexer, lastEraIdx, eraRewards, event.blockNumber);
}

async function upsertIndexerLastRewardEra(
  indexerAddress: string,
  eraIdx: BigNumber,
  eventBlock: number
): Promise<BigNumber> {
  const indexer = await Indexer.get(indexerAddress);

  assert(indexer, "Indexer Doesn't exist");

  const lastRewardedEra = indexer.lastRewardedEra
    ? BigNumber.from(indexer.lastRewardedEra)
    : undefined;

  if (!lastRewardedEra || lastRewardedEra.lt(eraIdx)) {
    indexer.lastRewardedEra = eraIdx.toHexString();
    indexer.lastEvent = `handleRewardsUpdated:upsertIndexerLastRewardEra:${eventBlock}`;

    await indexer.save();

    return eraIdx;
  } else {
    return lastRewardedEra;
  }
}

async function updateFutureRewards(
  indexer: string,
  lastRewardedEra: BigNumber,
  prevEraRewards: Readonly<IndexerReward>,
  eventBlock: number
) {
  let prev = prevEraRewards;
  let prevEraId = BigNumber.from(prevEraRewards.eraIdx);

  // Recalc all rewards until we get to the lastRewardedEra
  while (prevEraId.lte(lastRewardedEra)) {
    const eraId = BigNumber.from(prev.eraIdx).add(1);
    const id = getIndexerRewardId(indexer, eraId);

    let eraReward = await IndexerReward.get(id);

    if (eraReward) {
      eraReward.amount = prev.amount + eraReward.additions - eraReward.removals;
      eraReward.lastEvent = `handleRewardsUpdated:updateFutureRewards:${eventBlock}`;
    } else {
      eraReward = IndexerReward.create({
        id,
        indexerId: indexer,
        // eraId: eraId.toHexString(),
        eraIdx: eraId.toHexString(),
        additions: BigInt(0),
        removals: BigInt(0),
        amount: prev.amount,
        createdBlock: eventBlock,
      });
    }
    await eraReward.save();

    prev = eraReward;
    prevEraId = eraId;
  }
}
