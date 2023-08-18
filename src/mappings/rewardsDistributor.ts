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
import { getCurrentEra } from './eraManager';

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

  const { indexer, eraIdx, commission } = event.args;
  const delegators = await Delegation.getByIndexerId(indexer);
  if (!delegators) return;

  const network = await api.getNetwork();
  const rewardsDistributor = RewardsDistributer__factory.connect(
    getContractAddress(network.chainId, Contracts.REWARD_DIST_ADDRESS),
    api
  );

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
      await createEraReward({
        indexerId: indexer,
        delegatorId: delegator.delegatorId,
        eraId: eraIdx.toHexString(),
        eraIdx: eraIdx.toNumber(),
        isCommission: false,
        claimed: false,
        amount: rewards.toBigInt(),
        createdBlock: event.blockNumber,
        createdTimestamp: biToDate(event.block.timestamp),
      });
    }
  }

  if (commission.gt(0)) {
    await createEraReward({
      indexerId: indexer,
      delegatorId: indexer,
      eraId: eraIdx.toHexString(),
      eraIdx: eraIdx.toNumber(),
      isCommission: true,
      claimed: true, // commission rewards already in indexer's account
      amount: commission.toBigInt(),
      createdBlock: event.blockNumber,
      createdTimestamp: biToDate(event.block.timestamp),
    });
  }
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
  eraIdx: number;
  isCommission: boolean;
  claimed: boolean;
  amount?: bigint;
  createdBlock?: number;
  createdTimestamp?: Date;
}

async function createEraReward(data: EraRewardData): Promise<EraReward | null> {
  logger.info('updateEraReward', data);

  const id = `${data.indexerId}_${data.delegatorId}_${data.eraId}${
    data.isCommission ? '_commission' : ''
  }`;

  const eraReward = EraReward.create({
    id,
    indexerId: data.indexerId,
    delegatorId: data.delegatorId,
    eraId: data.eraId,
    eraIdx: data.eraIdx,
    isIndexer: data.indexerId === data.delegatorId,
    isCommission: data.isCommission,
    claimed: data.claimed,
    amount: data.amount ?? BigInt(0),
    createdBlock: data.createdBlock,
    createdTimestamp: data.createdTimestamp ?? new Date(),
  });

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

  const currentEra = await getCurrentEra();
  let lastClaimedEra = eraRewardClaimed.lastClaimedEra;

  while (lastClaimedEra + 1 < currentEra) {
    lastClaimedEra++;
    const eraRewardId = `${id}_${BigNumber.from(lastClaimedEra).toHexString()}`;
    const eraReward = await EraReward.get(eraRewardId);

    if (!eraReward || eraReward.claimed) continue;

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
