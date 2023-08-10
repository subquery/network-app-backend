// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  Delegation,
  IndexerReward,
  Indexer,
  Reward,
  UnclaimedReward,
  EraReward,
  EraRewardClaimed,
} from '../types';
import { RewardsDistributer__factory } from '@subql/contract-sdk';
import {
  ClaimRewardsEvent,
  DistributeRewardsEvent,
  RewardsChangedEvent,
} from '@subql/contract-sdk/typechain/RewardsDistributer';
import { biToDate, Contracts, getContractAddress } from './utils';
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
  logger.info(
    `handleRewardsDistributed: ${event.blockNumber}-${event.transactionHash}-${event.logIndex}`
  );
  assert(event.args, 'No event args');

  const { indexer, eraIdx, rewards: eventRewards } = event.args;
  const delegators = await Delegation.getByIndexerId(indexer);
  if (!delegators) return;

  const network = await api.getNetwork();
  const rewardsDistributor = RewardsDistributer__factory.connect(
    getContractAddress(network.chainId, Contracts.REWARD_DIST_ADDRESS),
    api
  );

  let accumulatedEraRewards = BigInt(0);

  for (const delegator of delegators.sort((a, b) =>
    a.delegatorId.localeCompare(b.delegatorId)
  )) {
    const rewards = await rewardsDistributor.userRewards(
      indexer,
      delegator.delegatorId
    );
    const id = buildRewardId(indexer, delegator.delegatorId);

    let reward = await UnclaimedReward.get(id);
    let rewardChanged = false;
    let rewardOld = BigInt(0);
    if (!reward) {
      reward = UnclaimedReward.create({
        id,
        delegatorAddress: delegator.delegatorId,
        delegatorId: delegator.delegatorId,
        indexerAddress: indexer,
        amount: rewards.toBigInt(),
        createdBlock: event.blockNumber,
      });
      rewardChanged = rewards.gt(0);
    } else {
      rewardChanged = reward.amount !== rewards.toBigInt();
      if (rewardChanged) {
        rewardOld = reward.amount;
        reward.amount = rewards.toBigInt();
        reward.lastEvent = `handleRewardsDistributed:${event.blockNumber}`;
      }
    }

    await reward.save();

    if (delegator.exitEra && delegator.exitEra <= eraIdx.toNumber()) {
      assert(
        !rewardChanged,
        `exited delegator should not have reward changed: ${delegator.id} / ${reward.indexerAddress}, ${rewardOld} -> ${reward.amount}`
      );
      await Delegation.remove(delegator.id);
    }

    if (rewards.gt(0)) {
      const eraReward = await updateEraReward({
        indexerId: indexer,
        delegatorId: delegator.delegatorId,
        eraId: eraIdx.toHexString(),
        isCommission: false,
        claimed: false,
        amount: rewards.toBigInt() - rewardOld,
        createdBlock: event.blockNumber,
        createdTimestamp: biToDate(event.block.timestamp),
      });
      accumulatedEraRewards += eraReward.amount;
    }
  }

  await updateEraReward({
    indexerId: indexer,
    delegatorId: indexer,
    eraId: eraIdx.toHexString(),
    isCommission: true,
    claimed: true, // commission rewards already in indexer's account
    // amount: rewards.mul(commission).div(100).toBigInt(),
    amount: eventRewards.toBigInt() - accumulatedEraRewards,
    createdBlock: event.blockNumber,
    createdTimestamp: biToDate(event.block.timestamp),
  });
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
      delegatorId: event.args.delegator,
      amount: event.args.rewards.toBigInt(),
      claimedTime: biToDate(event.block.timestamp),
      createdBlock: event.blockNumber,
    });

    await reward.save();
  } catch {
    logger.error(`ERROR: handleRewardsClaimed`);
  }

  await updateEraRewardClaimed(event);
}

interface EraRewardData {
  indexerId: string;
  delegatorId: string;
  eraId: string;
  isCommission: boolean;
  claimed: boolean;
  amount?: bigint;
  createdBlock?: number;
  createdTimestamp?: Date;
}

async function updateEraReward(data: EraRewardData): Promise<EraReward> {
  console.log('updateEraReward', data);

  const id = `${data.indexerId}_${data.delegatorId}_${data.eraId}${
    data.isCommission ? '_commission' : ''
  }`;

  let eraReward = await EraReward.get(id);

  if (!eraReward) {
    eraReward = EraReward.create({
      id,
      indexerId: data.indexerId,
      delegatorId: data.delegatorId,
      eraId: data.eraId,
      isIndexer: data.indexerId === data.delegatorId,
      claimed: data.claimed,
      amount: data.amount ?? BigInt(0),
      createdBlock: data.createdBlock,
      createdTimestamp: data.createdTimestamp ?? new Date(),
    });
  } else {
    eraReward.claimed = data.claimed;

    eraReward.amount = data.amount ?? eraReward.amount;
    eraReward.createdBlock = data.createdBlock ?? eraReward.createdBlock;
    eraReward.createdTimestamp =
      data.createdTimestamp ?? eraReward.createdTimestamp;
  }

  await eraReward.save();
  return eraReward;
}

async function updateEraRewardClaimed(
  event: EthereumLog<ClaimRewardsEvent['args']>
): Promise<void> {
  logger.info('updateEraRewardClaimed');
  assert(event.args, 'No event args');

  const { indexer, delegator } = event.args;
  const id = `${indexer}_${delegator}`;

  let eraRewardClaimed = await EraRewardClaimed.get(id);
  if (!eraRewardClaimed) {
    eraRewardClaimed = EraRewardClaimed.create({
      id,
      lastClaimedEra: 0,
    });
  }

  let lastClaimedEra = eraRewardClaimed.lastClaimedEra;
  const hasNextEraReward = true;

  while (hasNextEraReward) {
    const eraReward = await EraReward.get(`${id}_${lastClaimedEra + 1}`);
    if (!eraReward) break;

    lastClaimedEra++;
    if (!eraReward.claimed) continue;

    eraReward.claimed = true;
    await eraReward.save();
  }

  if (lastClaimedEra > eraRewardClaimed.lastClaimedEra) {
    eraRewardClaimed.lastClaimedEra = lastClaimedEra;
    await eraRewardClaimed.save();
  }
}

export async function handleRewardsUpdated(
  event: EthereumLog<RewardsChangedEvent['args']>
): Promise<void> {
  logger.info('handleRewardsUpdated');
  assert(event.args, 'No event args');

  const { indexer, eraIdx, additions, removals } = event.args;

  const prevEraRewards = await IndexerReward.get(
    getPrevIndexerRewardId(indexer, eraIdx)
  );
  const prevAmount = prevEraRewards?.amount ?? BigInt(0);

  const id = getIndexerRewardId(indexer, eraIdx);
  let eraRewards = await IndexerReward.get(id);
  // Hook for `additions` equal to zero
  const additionValue = additions.eq(0)
    ? BigNumber.from(eraRewards?.additions ?? 0)
    : additions;
  if (!eraRewards) {
    eraRewards = IndexerReward.create({
      id,
      indexerId: indexer,
      eraIdx: eraIdx.toHexString(),
      eraId: eraIdx.toBigInt(),
      additions: additionValue.toBigInt(),
      removals: removals.toBigInt(),
      amount: BigInt(0), // Updated below
      createdBlock: event.blockNumber,
    });
  } else {
    eraRewards.additions = additionValue.toBigInt();
    eraRewards.removals = removals.toBigInt();
    eraRewards.lastEvent = `handleRewardsUpdated:${event.blockNumber}`;
  }

  eraRewards.amount =
    prevAmount + additionValue.toBigInt() - removals.toBigInt();

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
        eraId: eraId.toBigInt(),
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
