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
import { IndexerRewardProps } from '../types/models/IndexerReward';

type IndexerRewardCacheItem = {
  lastUpdatedEra: bigint;
  rewardChange: bigint;
};

const indexerRewardCache: Record<string, IndexerRewardCacheItem> = {};

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
      logger.info(`Delegation remove: ${delegator.id}`);
      await Delegation.remove(delegator.id);
    }

    if (rewards.gt(0) && rewardChanged) {
      await createEraReward({
        indexerId: indexer,
        delegatorId: delegator.delegatorId,
        eraId: eraIdx.toHexString(),
        eraIdx: eraIdx.toNumber(),
        isCommission: false,
        claimed: false,
        amount: rewards.toBigInt() - rewardOld,
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

  await UnclaimedReward.remove(id);

  await Reward.create({
    id: `${id}:${event.transactionHash}`,
    indexerAddress: event.args.indexer,
    delegatorAddress: event.args.delegator,
    delegatorId: event.args.delegator,
    amount: event.args.rewards.toBigInt(),
    claimedTime: biToDate(event.block.timestamp),
    createdBlock: event.blockNumber,
  }).save();

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

// once each era
async function createEraReward(data: EraRewardData): Promise<EraReward | null> {
  logger.info('updateEraReward', data);

  const id = `${data.indexerId}:${data.delegatorId}:${data.eraId}${
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
  const id = `${indexer}:${delegator}`;

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
    const eraRewardId = `${id}:${BigNumber.from(lastClaimedEra).toHexString()}`;
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

  const existingReward = await IndexerReward.get(
    getIndexerRewardId(indexer, eraIdx)
  );
  const additionChange =
    additions.toBigInt() - (existingReward?.additions || BigInt(0));
  const removalChange =
    removals.toBigInt() - (existingReward?.removals || BigInt(0));

  let cache = indexerRewardCache[event.blockNumber];
  if (!cache) {
    cache = {
      lastUpdatedEra: eraIdx.toBigInt(),
      rewardChange: additionChange - removalChange,
    };
    indexerRewardCache[event.blockNumber] = cache;
  }
  cache.rewardChange += additionChange - removalChange;
  if (cache.rewardChange === BigInt(0)) {
    delete indexerRewardCache[event.blockNumber];
  }

  let prevAmount = BigInt(0);
  if (cache.lastUpdatedEra < eraIdx.toBigInt() - BigInt(1)) {
    prevAmount = await IndexerReward.get(
      getIndexerRewardId(indexer, BigNumber.from(cache.lastUpdatedEra))
    ).then((r) => r?.amount || BigInt(0));
  }
  while (cache.lastUpdatedEra < eraIdx.toBigInt() - BigInt(1)) {
    const eraToUpdate = cache.lastUpdatedEra + BigInt(1);
    prevAmount = await upsertIndexerReward(
      {
        id: getIndexerRewardId(indexer, BigNumber.from(eraToUpdate)),
        indexerId: indexer,
        eraIdx: eraToUpdate.toString(),
        eraId: eraToUpdate,
        additions: BigInt(0),
        removals: BigInt(0),
        amount: BigInt(0), // update in function
        createdBlock: event.blockNumber,
        lastEvent: `handleRewardsUpdated:${event.blockNumber}`,
      },
      cache,
      prevAmount,
      false
    ).then((r) => r.amount);
  }

  if (prevAmount === BigInt(0)) {
    prevAmount = await IndexerReward.get(
      getPrevIndexerRewardId(indexer, eraIdx)
    ).then((r) => r?.amount || BigInt(0));
  }

  const indexerReward = await upsertIndexerReward(
    {
      id: getIndexerRewardId(indexer, eraIdx),
      indexerId: indexer,
      eraIdx: eraIdx.toHexString(),
      eraId: eraIdx.toBigInt(),
      additions: additions.toBigInt(),
      removals: removals.toBigInt(),
      amount: BigInt(0), // update in function
      createdBlock: event.blockNumber,
      lastEvent: `handleRewardsUpdated:${event.blockNumber}`,
    },
    cache,
    prevAmount,
    true
  );

  const lastEraIdx = await upsertIndexerLastRewardEra(
    indexer,
    eraIdx,
    event.blockNumber
  );

  /* Rewards changed events don't come in in order and may not be the latest set era */
  await updateFutureRewards(
    indexer,
    lastEraIdx,
    indexerReward,
    event.blockNumber
  );
}

async function upsertIndexerReward(
  data: IndexerRewardProps,
  cache: IndexerRewardCacheItem,
  prevAmount: bigint,
  modifyAddRem = true
) {
  let indexerReward = await IndexerReward.get(data.id);
  if (!indexerReward) {
    indexerReward = IndexerReward.create(data);
  } else if (modifyAddRem) {
    indexerReward.additions = data.additions;
    indexerReward.removals = data.removals;
  }
  indexerReward.amount =
    prevAmount + indexerReward.additions - indexerReward.removals;
  await indexerReward.save();

  cache.lastUpdatedEra = data.eraId;

  return indexerReward;
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
