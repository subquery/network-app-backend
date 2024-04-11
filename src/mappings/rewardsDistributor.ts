// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  Delegation,
  IndexerReward,
  Reward,
  UnclaimedReward,
  EraReward,
  EraRewardClaimed,
  Era,
  EraIndexerDelegator,
  EraIndexerAPR,
  EraDelegatorIndexerAPR,
  EraDelegatorAPR,
  EraDelegatorIndexer,
  EraIndexerDeploymentAPR,
  IndexerAllocationSummary,
} from '../types';
import {
  EraManager__factory,
  ServiceAgreementRegistry__factory,
} from '@subql/contract-sdk';
import {
  ClaimRewardsEvent,
  DistributeRewardsEvent,
  RewardsChangedEvent,
} from '@subql/contract-sdk/typechain/contracts/RewardsDistributor';
import {
  biToDate,
  bnToDate,
  calcApr,
  Contracts,
  getContractAddress,
  getDelegationId,
  toBigInt,
} from './utils';
import { EthereumLog } from '@subql/types-ethereum';
import { BigNumber } from '@ethersproject/bignumber';
import BignumberJs from 'bignumber.js';
import { getCurrentEra } from './eraManager';
import {
  AgreementRewardsEvent,
  InstantRewardsEvent,
} from '../types/contracts/RewardsDistributor';
import { RewardType } from './utils/enums';

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

  const { runner, eraIdx, rewards: totalRewards, commission } = event.args;
  const eraIndexerDelegator =
    (await EraIndexerDelegator.get(`${runner}:${eraIdx.toHexString()}`)) ||
    (await EraIndexerDelegator.get(runner));
  if (!eraIndexerDelegator) return;
  if (eraIndexerDelegator.era > eraIdx.toNumber()) {
    throw new Error(
      `EraIndexerDelegator era is greater than the current era: ${
        eraIndexerDelegator.era
      } > ${eraIdx.toNumber()}`
    );
  }
  const delegations = eraIndexerDelegator?.delegators;
  const totalDelegation = eraIndexerDelegator.totalStake;

  for (const delegationFrom of delegations) {
    const delegationAmount = toBigInt(delegationFrom.amount.toString());
    const estimatedRewards = totalRewards
      .sub(commission)
      .mul(delegationAmount)
      .div(totalDelegation);

    const id = buildRewardId(runner, delegationFrom.delegator);
    let reward = await UnclaimedReward.get(id);
    if (!reward) {
      reward = UnclaimedReward.create({
        id,
        delegatorAddress: delegationFrom.delegator,
        delegatorId: delegationFrom.delegator,
        indexerAddress: runner,
        amount: estimatedRewards.toBigInt(),
        createdBlock: event.blockNumber,
      });
    } else {
      reward.amount += estimatedRewards.toBigInt();
      reward.lastEvent = `handleRewardsDistributed:${event.blockNumber}`;
    }
    await reward.save();

    const delegationId = getDelegationId(delegationFrom.delegator, runner);
    const delegation = await Delegation.get(delegationId);
    assert(delegation, `delegation not found: ${delegationId}`);
    if (delegation.exitEra && delegation.exitEra <= eraIdx.toNumber()) {
      assert(
        estimatedRewards.eq(0),
        `exited delegator should not have reward changed: ${delegation.id} / ${
          reward.indexerAddress
        }, ${estimatedRewards.toNumber()}`
      );
      logger.info(`Delegation remove: ${delegation.id}`);
      await Delegation.remove(delegation.id);
    }

    if (estimatedRewards.gt(0)) {
      const eraReward = await createEraReward({
        indexerId: runner,
        delegatorId: delegationFrom.delegator,
        eraId: eraIdx.toHexString(),
        eraIdx: eraIdx.toNumber(),
        isCommission: false,
        claimed: false,
        amount: estimatedRewards.toBigInt(),
        createdBlock: event.blockNumber,
        createdTimestamp: biToDate(event.block.timestamp),
      });
      await upsertEraApr(eraReward);
    }
  }

  if (commission.gt(0)) {
    const eraReward = await createEraReward({
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
    await upsertEraApr(eraReward);
  }
}

function getEraDelegationAmount(
  delegation: Delegation,
  eraIdx: BigNumber
): BigNumber {
  const value = BigNumber.from(delegation.amount.value.value);
  const valueAfter = BigNumber.from(delegation.amount.valueAfter.value);
  return eraIdx.gt(delegation.amount.era) ? valueAfter : value;
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
  amount: bigint;
  createdBlock: number;
  createdTimestamp: Date;
}

// once each era
async function createEraReward(data: EraRewardData): Promise<EraReward> {
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
    amount: data.amount,
    createdBlock: data.createdBlock,
    createdTimestamp: data.createdTimestamp,
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

async function upsertEraApr(eraReward: EraReward) {
  await upsertEraIndexerApr(eraReward);
  if (!eraReward.isIndexer) {
    await upsertEraDelegatorApr(eraReward);
  }
}

async function upsertEraIndexerApr(eraReward: EraReward) {
  const eraIndexerAprId = `${eraReward.indexerId}:${eraReward.eraId}`;
  let eraIndexerApr = await EraIndexerAPR.get(eraIndexerAprId);
  if (!eraIndexerApr) {
    eraIndexerApr = EraIndexerAPR.create({
      id: eraIndexerAprId,
      indexerId: eraReward.indexerId,
      eraIdx: eraReward.eraIdx,
      indexerReward: BigInt(0),
      indexerApr: BigInt(0),
      delegatorReward: BigInt(0),
      delegatorApr: BigInt(0),
      createAt: eraReward.createdTimestamp,
      updateAt: eraReward.createdTimestamp,
    });
  }

  const eraIndexerDelegator =
    (await EraIndexerDelegator.get(
      `${eraReward.indexerId}:${eraReward.eraId}`
    )) || (await EraIndexerDelegator.get(eraReward.indexerId));
  assert(eraIndexerDelegator, 'EraIndexerDelegator not found');
  const selfStake = eraIndexerDelegator.selfStake;
  const delegatorStake = eraIndexerDelegator.totalStake - selfStake;

  if (eraReward.isIndexer) {
    eraIndexerApr.indexerReward += eraReward.amount;
    eraIndexerApr.indexerApr = calcApr(eraIndexerApr.indexerReward, selfStake);
  } else {
    eraIndexerApr.delegatorReward += eraReward.amount;
    eraIndexerApr.delegatorApr = calcApr(
      eraIndexerApr.delegatorReward,
      delegatorStake
    );
  }
  eraIndexerApr.updateAt = eraReward.createdTimestamp;
  await eraIndexerApr.save();
}

async function upsertEraDelegatorApr(eraReward: EraReward) {
  const eraDelegatorAprId = `${eraReward.delegatorId}:${eraReward.eraId}`;
  let eraDelegatorApr = await EraDelegatorAPR.get(eraDelegatorAprId);
  if (!eraDelegatorApr) {
    eraDelegatorApr = EraDelegatorAPR.create({
      id: eraDelegatorAprId,
      delegatorId: eraReward.delegatorId,
      eraIdx: eraReward.eraIdx,
      reward: BigInt(0),
      apr: BigInt(0),
      createAt: eraReward.createdTimestamp,
      updateAt: eraReward.createdTimestamp,
    });
  }

  const eraDelegatorIndexer =
    (await EraDelegatorIndexer.get(
      `${eraReward.delegatorId}:${eraReward.indexerId}`
    )) || (await EraDelegatorIndexer.get(eraReward.delegatorId));
  assert(eraDelegatorIndexer, 'EraDelegatorIndexer not found');

  eraDelegatorApr.reward += eraReward.amount;
  eraDelegatorApr.apr = calcApr(
    eraDelegatorApr.reward,
    eraDelegatorIndexer.totalStake - eraDelegatorIndexer.selfStake
  );
  eraDelegatorApr.updateAt = eraReward.createdTimestamp;
  await eraDelegatorApr.save();

  const eraDelegatorIndxerAprId = `${eraReward.delegatorId}:${eraReward.indexerId}:${eraReward.eraId}`;
  let eraDelegatorIndexerApr = await EraDelegatorIndexerAPR.get(
    eraDelegatorIndxerAprId
  );
  if (!eraDelegatorIndexerApr) {
    eraDelegatorIndexerApr = EraDelegatorIndexerAPR.create({
      id: eraDelegatorIndxerAprId,
      eraIdx: eraReward.eraIdx,
      delegatorId: eraReward.delegatorId,
      indexerId: eraReward.indexerId,
      reward: BigInt(0),
      apr: BigInt(0),
      createAt: eraReward.createdTimestamp,
      updateAt: eraReward.createdTimestamp,
    });
  }

  eraDelegatorIndexerApr.reward += eraReward.amount;
  eraDelegatorIndexerApr.apr = calcApr(
    eraDelegatorIndexerApr.reward,
    eraDelegatorIndexer.indexers.find((i) => i.indexer === eraReward.indexerId)
      ?.amount ?? BigInt(0)
  );
  eraDelegatorIndexerApr.updateAt = eraReward.createdTimestamp;
  await eraDelegatorIndexerApr.save();
}

export async function upsertEraIndexerDeploymentApr(
  indexerId: string,
  deploymentId: string,
  eraIdx: number,
  rewardType: RewardType,
  add: bigint,
  remove: bigint,
  updateAt: Date
) {
  const aprId = `${indexerId}:${deploymentId}:${eraIdx}`;
  let apr = await EraIndexerDeploymentAPR.get(aprId);
  if (!apr) {
    apr = EraIndexerDeploymentAPR.create({
      id: aprId,
      indexerId,
      deploymentId,
      eraIdx,
      agreementReward: BigInt(0),
      flexPlanReward: BigInt(0),
      allocationReward: BigInt(0),
      apr: BigInt(0),
      createAt: updateAt,
      updateAt: updateAt,
    });
  }
  switch (rewardType) {
    case RewardType.AGREEMENT:
      apr.agreementReward += add - remove;
      break;
    case RewardType.FLEX_PLAN:
      apr.flexPlanReward += add - remove;
      break;
    case RewardType.ALLOCATION: {
      apr.allocationReward += add - remove;
      const allocation =
        (await IndexerAllocationSummary.get(`${deploymentId}:${indexerId}`))
          ?.totalAmount || BigInt(0);
      apr.apr = calcApr(apr.allocationReward, allocation);
      break;
    }
  }
  apr.updateAt = updateAt;
  await apr.save();
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
  const { startDate, period, deploymentId } =
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
      await upsertEraIndexerDeploymentApr(
        runner,
        deploymentId,
        currentEra,
        RewardType.AGREEMENT,
        amount.toBigInt(),
        BigInt(0),
        biToDate(event.block.timestamp)
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
  await upsertEraIndexerDeploymentApr(
    runner,
    deploymentId,
    currentEra,
    RewardType.AGREEMENT,
    BigInt(agreementFirstEraAmount.toFixed(0)),
    BigInt(0),
    biToDate(event.block.timestamp)
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
    await upsertEraIndexerDeploymentApr(
      runner,
      deploymentId,
      eraId.toNumber(),
      RewardType.AGREEMENT,
      BigInt(leftAmount.toFixed(0)),
      BigInt(0),
      biToDate(event.block.timestamp)
    );
    return;
  }

  // if the agreement has more than 2 era
  const leftEra = agreementLastEraNumbers.minus(agreementFirstEraRate);
  const integerPart = leftEra.integerValue(BignumberJs.ROUND_DOWN);
  const decimalPart = leftEra.minus(integerPart);
  const decimalPartAmount = everyEraAmount.multipliedBy(decimalPart);
  const lastEra = leftEra.integerValue(BignumberJs.ROUND_CEIL);

  for (let index = 0; index < integerPart.toNumber(); index++) {
    await updateOrCreateIndexerReward(
      getIndexerRewardId(runner, BigNumber.from(currentEra + index + 1)),
      BigNumber.from(everyEraAmount.toFixed(0)),
      runner,
      BigNumber.from(currentEra + index + 1),
      event.blockNumber,
      'handleServicesAgreementRewards'
    );
    await upsertEraIndexerDeploymentApr(
      runner,
      deploymentId,
      currentEra + index + 1,
      RewardType.AGREEMENT,
      BigInt(everyEraAmount.toFixed(0)),
      BigInt(0),
      biToDate(event.block.timestamp)
    );
  }
  await updateOrCreateIndexerReward(
    getIndexerRewardId(runner, BigNumber.from(currentEra + lastEra.toNumber())),
    BigNumber.from(decimalPartAmount.toFixed(0)),
    runner,
    BigNumber.from(currentEra + lastEra.toNumber()),
    event.blockNumber,
    'handleServicesAgreementRewards'
  );
  await upsertEraIndexerDeploymentApr(
    runner,
    deploymentId,
    currentEra + lastEra.toNumber(),
    RewardType.AGREEMENT,
    BigInt(decimalPartAmount.toFixed(0)),
    BigInt(0),
    biToDate(event.block.timestamp)
  );
}
