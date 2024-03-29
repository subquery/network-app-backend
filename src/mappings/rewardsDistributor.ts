// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
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
  Era,
} from '../types';
import {
  EraManager__factory,
  RewardsDistributor__factory,
  ServiceAgreementRegistry__factory,
} from '@subql/contract-sdk';
import {
  ClaimRewardsEvent,
  DistributeRewardsEvent,
  RewardsChangedEvent,
} from '@subql/contract-sdk/typechain/contracts/RewardsDistributor';
import { biToDate, bnToDate, Contracts, getContractAddress } from './utils';
import { EthereumLog } from '@subql/types-ethereum';
import { BigNumber } from '@ethersproject/bignumber';
import BignumberJs from 'bignumber.js';
import { getCurrentEra } from './eraManager';
import {
  AgreementRewardsEvent,
  InstantRewardsEvent,
} from '../types/contracts/RewardsDistributor';

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

  const { runner, eraIdx, commission } = event.args;
  const delegators = await Delegation.getByIndexerId(runner);
  if (!delegators) return;

  const network = await api.getNetwork();
  const rewardsDistributor = RewardsDistributor__factory.connect(
    getContractAddress(network.chainId, Contracts.REWARD_DIST_ADDRESS),
    api
  );

  for (const delegator of delegators.sort((a, b) =>
    a.delegatorId.localeCompare(b.delegatorId)
  )) {
    const rewards = await rewardsDistributor.userRewards(
      runner,
      delegator.delegatorId
    );
    const id = buildRewardId(runner, delegator.delegatorId);

    let reward = await UnclaimedReward.get(id);
    let rewardChanged = false;
    let rewardOld = BigInt(0);
    if (!reward) {
      reward = UnclaimedReward.create({
        id,
        delegatorAddress: delegator.delegatorId,
        delegatorId: delegator.delegatorId,
        indexerAddress: runner,
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
        indexerId: runner,
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
      indexerId: runner,
      delegatorId: runner,
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

  const id = buildRewardId(event.args.runner, event.args.delegator);

  await UnclaimedReward.remove(id);

  await Reward.create({
    id: `${id}:${event.transactionHash}`,
    indexerAddress: event.args.runner,
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

  const { runner, delegator } = event.args;
  const id = `${runner}:${delegator}`;

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
): Promise<void> {}

const updateOrCreateIndexerReward = async (
  id: string,
  amount: BigNumber,
  runner: string,
  eraIdx: BigNumber,
  blockNumber: number,
  lastEventString: string
) => {
  const existIndexerRewards = await IndexerReward.get(id);
  if (existIndexerRewards) {
    existIndexerRewards.amount += amount.toBigInt();
    await existIndexerRewards.save();
    return;
  }

  const newIndexerRewards = IndexerReward.create({
    id,
    indexerId: runner,
    eraIdx: eraIdx.toHexString(),
    eraId: eraIdx.toBigInt(),
    amount: amount.toBigInt(),
    createdBlock: blockNumber,
    lastEvent: `${lastEventString}:${blockNumber}`,
  });

  await newIndexerRewards.save();
};

export async function handleInstantRewards(
  event: EthereumLog<InstantRewardsEvent['args']>
): Promise<void> {
  logger.info('handleInstantRewardsUpdated');
  assert(event.args, 'No event args');

  const { runner, eraIdx, token: amount } = event.args;
  const id = getIndexerRewardId(runner, eraIdx);
  await updateOrCreateIndexerReward(
    id,
    amount,
    runner,
    eraIdx,
    event.blockNumber,
    'handleInstantRewards'
  );
}

export async function handleAgreementRewards(
  event: EthereumLog<AgreementRewardsEvent['args']>
): Promise<void> {
  logger.info('handleAgreementRewardsUpdated');
  assert(event.args, 'No event args');

  const { runner, agreementId, token: amount } = event.args;

  const network = await api.getNetwork();
  const serviceAgreementContract = ServiceAgreementRegistry__factory.connect(
    getContractAddress(network.chainId, Contracts.SA_REGISTRY_ADDRESS),
    api
  );

  const eraManager = EraManager__factory.connect(
    getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
    api
  );

  const currentEra = await getCurrentEra();
  const currentEraInfo = await Era.get(
    BigNumber.from(currentEra).toHexString()
  );

  if (!currentEraInfo) {
    logger.error(`current era not found in records: ${currentEra}`);
    return;
  }

  const currentEraStartDate = new Date(currentEraInfo.startTime);

  const eraPeriod = await eraManager.eraPeriod();
  const { startDate, period } =
    await serviceAgreementContract.getClosedServiceAgreement(agreementId);

  const agreementStartDate = bnToDate(startDate);

  const agreementFirstEraRate = BignumberJs(1).minus(
    // the agreement start - era start is the time passed, these time they shouldn't get tokens
    // then / eraPeriod to get the rate.
    BignumberJs(agreementStartDate.getTime() - currentEraStartDate.getTime())
      .div(1000)
      .div(eraPeriod.toString())
  );

  const agreementLastEraNumbers = BignumberJs(period.toString()).div(
    eraPeriod.toString()
  );
  const everyEraAmount = BignumberJs(amount.toString()).div(
    agreementLastEraNumbers.toString()
  );

  // split the agreement to first ... last
  // first amount should be calculated by the rate of the first era
  const agreementFirstEraAmount = everyEraAmount.multipliedBy(
    agreementFirstEraRate
  );

  // this agreement less than 1 era
  if (agreementLastEraNumbers.lte(1)) {
    // if the agreement less than 1 era and will end before the next era
    if (
      +bnToDate(startDate.add(period)) <
      +currentEraInfo.startTime + eraPeriod.mul(1000).toNumber()
    ) {
      await updateOrCreateIndexerReward(
        getIndexerRewardId(runner, BigNumber.from(currentEra)),
        BigNumber.from(amount.toString()),
        runner,
        BigNumber.from(currentEra),
        event.blockNumber,
        'handleServicesAgreementRewards'
      );
      return;
    }
    // otherwise can use same process as the agreement has more than 1 era
  }

  await updateOrCreateIndexerReward(
    getIndexerRewardId(runner, BigNumber.from(currentEra)),
    BigNumber.from(agreementFirstEraAmount.toFixed(0)),
    runner,
    BigNumber.from(currentEra),
    event.blockNumber,
    'handleServicesAgreementRewards'
  );

  // minus first rate and then less than 1 indicates this agreement only have two era
  if (agreementLastEraNumbers.minus(agreementFirstEraRate).lte(1)) {
    const eraId = BigNumber.from(currentEra + 1);
    const leftAmount = BignumberJs(amount.toString()).minus(
      agreementFirstEraAmount
    );
    await updateOrCreateIndexerReward(
      getIndexerRewardId(runner, eraId),
      BigNumber.from(leftAmount.toFixed(0)),
      runner,
      eraId,
      event.blockNumber,
      'handleServicesAgreementRewards'
    );
    return;
  }

  // if the agreement has more than 2 era
  const leftEra = agreementLastEraNumbers.minus(agreementFirstEraRate);
  const integerPart = leftEra.integerValue(BignumberJs.ROUND_DOWN);
  const decimalPart = leftEra.minus(integerPart);
  const decimalPartAmount = everyEraAmount.multipliedBy(decimalPart);
  const lastEra = leftEra.integerValue(BignumberJs.ROUND_CEIL);

  await Promise.all([
    ...new Array(integerPart.toNumber()).fill(0).map((i, index) => {
      return updateOrCreateIndexerReward(
        getIndexerRewardId(runner, BigNumber.from(currentEra + index + 1)),
        BigNumber.from(everyEraAmount.toFixed(0)),
        runner,
        BigNumber.from(currentEra + index + 1),
        event.blockNumber,
        'handleServicesAgreementRewards'
      );
    }),
    updateOrCreateIndexerReward(
      getIndexerRewardId(
        runner,
        BigNumber.from(currentEra + lastEra.toNumber())
      ),
      BigNumber.from(decimalPartAmount.toFixed(0)),
      runner,
      BigNumber.from(currentEra + lastEra.toNumber()),
      event.blockNumber,
      'handleServicesAgreementRewards'
    ),
  ]);

  logger.info(runner);
}
