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
  EraIndexerApy,
  EraDelegatorIndexerApy,
  EraDelegatorApy,
  EraDelegatorIndexer,
  EraIndexerDeploymentApy,
  IndexerAllocationSummary,
  IndexerApySummary,
  IndexerStakeWeight,
  Indexer,
  OrderType,
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
  bytesToIpfsCid,
  calcApy,
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
import { PER_MILL } from './utils/constants';
import {
  addOrUpdateConsumerQuerySpent,
  addOrUpdateIndexerEraDeploymentRewards,
} from './rewardsPool';
import pino from 'pino';

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
  const indexerStakeWeight = await IndexerStakeWeight.get(runner);
  const weight = indexerStakeWeight?.weight || PER_MILL;
  const indexerDelegationAmount = toBigInt(
    delegations.find((d) => d.delegator === runner)?.amount?.toString()
  );

  let calculatedTotalDelegation = totalDelegation;
  let calculatedIndexerDelegationAmount = BigInt(0);
  if (weight !== PER_MILL) {
    calculatedIndexerDelegationAmount = BigNumber.from(indexerDelegationAmount)
      .mul(weight)
      .div(PER_MILL)
      .toBigInt();
    calculatedTotalDelegation = BigNumber.from(totalDelegation)
      .sub(indexerDelegationAmount)
      .add(calculatedIndexerDelegationAmount)
      .toBigInt();
  }

  for (const delegationFrom of delegations) {
    const delegationAmount = toBigInt(delegationFrom.amount.toString());
    let calculatedDelegationAmount = delegationAmount;
    if (runner === delegationFrom.delegator && weight !== PER_MILL) {
      calculatedDelegationAmount = calculatedIndexerDelegationAmount;
    }
    const estimatedRewards = totalRewards
      .sub(commission)
      .mul(calculatedDelegationAmount)
      .div(calculatedTotalDelegation);

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
      await upsertEraApy(eraReward);
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
    await upsertEraApy(eraReward);
  }

  const existIndexer = await Indexer.get(runner);
  if (existIndexer) {
    existIndexer.lastClaimEra = eraIdx.toString();
    await existIndexer.save();
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
    id: `${id}:${event.transactionHash}:${event.logIndex}`,
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
  let nextClaimEra = lastClaimedEra + 1;

  for (; nextClaimEra < currentEra; nextClaimEra++) {
    const eraRewardId = `${id}:${BigNumber.from(nextClaimEra).toHexString()}`;
    const eraReward = await EraReward.get(eraRewardId);

    if (!eraReward || eraReward.claimed) {
      continue;
    }

    eraReward.claimed = true;
    await eraReward.save();

    lastClaimedEra = nextClaimEra;
  }

  if (lastClaimedEra > eraRewardClaimed.lastClaimedEra) {
    eraRewardClaimed.lastClaimedEra = lastClaimedEra;
    await eraRewardClaimed.save();
  }
}

async function upsertEraApy(eraReward: EraReward) {
  await upsertEraIndexerApy(eraReward);
  if (!eraReward.isIndexer) {
    await upsertEraDelegatorApy(eraReward);
  }
}

async function upsertEraIndexerApy(eraReward: EraReward) {
  const eraIndexerApyId = `${eraReward.indexerId}:${eraReward.eraId}`;
  let eraIndexerApy = await EraIndexerApy.get(eraIndexerApyId);
  if (!eraIndexerApy) {
    eraIndexerApy = EraIndexerApy.create({
      id: eraIndexerApyId,
      indexerId: eraReward.indexerId,
      eraIdx: eraReward.eraIdx,
      indexerReward: BigInt(0),
      indexerApy: BigInt(0),
      delegatorReward: BigInt(0),
      delegatorApy: BigInt(0),
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
    eraIndexerApy.indexerReward += eraReward.amount;
    eraIndexerApy.indexerApy = calcApy(eraIndexerApy.indexerReward, selfStake);
  } else {
    eraIndexerApy.delegatorReward += eraReward.amount;
    eraIndexerApy.delegatorApy = calcApy(
      eraIndexerApy.delegatorReward,
      delegatorStake
    );
  }
  eraIndexerApy.updateAt = eraReward.createdTimestamp;
  await eraIndexerApy.save();

  const past3EraRecords = await EraIndexerApy.getByFields(
    [['indexerId', '=', eraReward.indexerId]],
    { orderBy: 'eraIdx', limit: 3, offset: 0, orderDirection: 'DESC' }
  );
  logger.info('past3EraRecords', past3EraRecords);
  const countOfPast3EraRecords = past3EraRecords.length;
  const past3EraIndexerApy = past3EraRecords
    .reduce(
      (add, cur) => BignumberJs(cur.indexerApy.toString()).plus(add),
      BignumberJs(0)
    )
    .div(countOfPast3EraRecords || 1);

  const past3EraDelegatorApy = past3EraRecords
    .reduce(
      (add, cur) => BignumberJs(cur.delegatorApy.toString()).plus(add),
      BignumberJs(0)
    )
    .div(countOfPast3EraRecords || 1);

  await IndexerApySummary.create({
    id: `${eraReward.indexerId}`,
    indexerId: eraIndexerApy.indexerId,
    eraIdx: eraIndexerApy.eraIdx,
    indexerReward: eraIndexerApy.indexerReward,
    indexerApy: BigInt(past3EraIndexerApy.toFixed(0)),
    delegatorReward: eraIndexerApy.delegatorReward,
    delegatorApy: BigInt(past3EraDelegatorApy.toFixed(0)),
    createAt: eraIndexerApy.createAt,
    updateAt: eraIndexerApy.updateAt,
  }).save();
}

async function upsertEraDelegatorApy(eraReward: EraReward) {
  const eraDelegatorApyId = `${eraReward.delegatorId}:${eraReward.eraId}`;
  let eraDelegatorApy = await EraDelegatorApy.get(eraDelegatorApyId);
  if (!eraDelegatorApy) {
    eraDelegatorApy = EraDelegatorApy.create({
      id: eraDelegatorApyId,
      delegatorId: eraReward.delegatorId,
      eraIdx: eraReward.eraIdx,
      reward: BigInt(0),
      apy: BigInt(0),
      createAt: eraReward.createdTimestamp,
      updateAt: eraReward.createdTimestamp,
    });
  }

  const eraDelegatorIndexer =
    (await EraDelegatorIndexer.get(
      `${eraReward.delegatorId}:${eraReward.eraId}`
    )) || (await EraDelegatorIndexer.get(eraReward.delegatorId));
  assert(eraDelegatorIndexer, 'EraDelegatorIndexer not found');

  eraDelegatorApy.reward += eraReward.amount;
  eraDelegatorApy.apy = calcApy(
    eraDelegatorApy.reward,
    eraDelegatorIndexer.totalStake - eraDelegatorIndexer.selfStake
  );
  eraDelegatorApy.updateAt = eraReward.createdTimestamp;
  await eraDelegatorApy.save();

  const eraDelegatorIndxerApyId = `${eraReward.delegatorId}:${eraReward.indexerId}:${eraReward.eraId}`;
  let eraDelegatorIndexerApy = await EraDelegatorIndexerApy.get(
    eraDelegatorIndxerApyId
  );
  if (!eraDelegatorIndexerApy) {
    eraDelegatorIndexerApy = EraDelegatorIndexerApy.create({
      id: eraDelegatorIndxerApyId,
      eraIdx: eraReward.eraIdx,
      delegatorId: eraReward.delegatorId,
      indexerId: eraReward.indexerId,
      reward: BigInt(0),
      stake: BigInt(0),
      apy: BigInt(0),
      createAt: eraReward.createdTimestamp,
      updateAt: eraReward.createdTimestamp,
    });
  }

  eraDelegatorIndexerApy.reward += eraReward.amount;
  eraDelegatorIndexerApy.stake =
    toBigInt(
      eraDelegatorIndexer.indexers
        .find((i) => i.indexer === eraReward.indexerId)
        ?.amount?.toString()
    ) ?? BigInt(0);

  eraDelegatorIndexerApy.apy = calcApy(
    eraDelegatorIndexerApy.reward,
    eraDelegatorIndexerApy.stake
  );
  eraDelegatorIndexerApy.updateAt = eraReward.createdTimestamp;
  await eraDelegatorIndexerApy.save();
}

export async function upsertEraIndexerDeploymentApy(
  indexerId: string,
  deploymentId: string,
  eraIdx: number,
  rewardType: RewardType,
  add: bigint,
  remove: bigint,
  updateAt: Date
) {
  const apyId = `${indexerId}:${deploymentId}:${eraIdx}`;
  const eraInfo = await Era.get(BigNumber.from(eraIdx).toHexString());
  const period = eraInfo?.eraPeriod || '0';
  let apy = await EraIndexerDeploymentApy.get(apyId);

  if (!apy) {
    const currentAllocation =
      (await IndexerAllocationSummary.get(`${deploymentId}:${indexerId}`))
        ?.totalAmount || BigInt(0);
    apy = EraIndexerDeploymentApy.create({
      id: apyId,
      indexerId,
      deploymentId,
      eraIdx,
      agreementReward: BigInt(0),
      flexPlanReward: BigInt(0),
      allocationReward: BigInt(0),
      apy: BigInt(0),
      createAt: updateAt,
      updateAt: updateAt,

      apyCalcAllocation: currentAllocation,
      apyCalcAdded: BigInt(0),
      apyCalcRemoval: BigInt(0),
      apyCalcAllocationRecordAt: eraInfo?.startTime || updateAt, // era start must be exist.
      apyCalcHistory: '',
    });
  }

  switch (rewardType) {
    case RewardType.AGREEMENT:
      apy.agreementReward += add - remove;
      break;
    case RewardType.FLEX_PLAN:
      apy.flexPlanReward += add - remove;
      break;
    case RewardType.ALLOCATION: {
      apy.allocationReward += add - remove;

      const removal = BignumberJs(apy.apyCalcRemoval.toString());
      const added = BignumberJs(apy.apyCalcAdded.toString());

      const percentage = BignumberJs(1).minus(
        BignumberJs(+apy.apyCalcAllocationRecordAt)
          .minus(+(eraInfo?.startTime || 0))
          .div(period)
      );
      if (!removal.isZero()) {
        apy.apyCalcAllocation -= BigInt(
          removal.multipliedBy(percentage).toFixed(0)
        );

        apy.apyCalcRemoval = BigInt(0);
      }

      if (!added.isZero()) {
        apy.apyCalcAllocation += BigInt(
          added.multipliedBy(percentage).toFixed(0)
        );

        apy.apyCalcAdded = BigInt(0);
      }

      apy.apy = calcApy(apy.allocationReward, apy.apyCalcAllocation);
      break;
    }
  }
  apy.updateAt = updateAt;
  await apy.save();
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
  const { startDate, period, deploymentId, consumer } =
    await serviceAgreementContract.getClosedServiceAgreement(agreementId);

  const cidDeploymentId = bytesToIpfsCid(deploymentId);

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

  async function saveDatas(leftAmount?: BignumberJs, eraId?: BigNumber) {
    const saveAmount = BigNumber.from(leftAmount?.toFixed(0) || amount);
    const saveEra = eraId?.toNumber() || currentEra;
    await updateOrCreateIndexerReward(
      getIndexerRewardId(runner, BigNumber.from(saveEra)),
      BigNumber.from(saveAmount.toString()),
      runner,
      BigNumber.from(saveEra),
      event.blockNumber,
      'handleServicesAgreementRewards'
    );
    await upsertEraIndexerDeploymentApy(
      runner,
      cidDeploymentId,
      saveEra,
      RewardType.AGREEMENT,
      saveAmount.toBigInt(),
      BigInt(0),
      biToDate(event.block.timestamp)
    );
    await addOrUpdateIndexerEraDeploymentRewards(
      runner,
      cidDeploymentId,
      saveEra,
      BigNumber.from(0).toBigInt(),
      BigNumber.from(0).toBigInt(),
      saveAmount.toBigInt(),
      `handleServicesAgreementRewards:${event.blockNumber}`
    );

    await addOrUpdateConsumerQuerySpent(
      consumer,
      runner,
      bytesToIpfsCid(deploymentId),
      saveEra,
      OrderType.SERVICE_AGREEMENT,
      agreementId.toHexString(),
      saveAmount.toBigInt(),
      biToDate(event.block.timestamp),
      `handleServicesAgreementRewards:${event.blockNumber}`
    );
  }

  // this agreement less than 1 era
  if (agreementLastEraNumbers.lte(1)) {
    // if the agreement less than 1 era and will end before the next era
    if (
      +bnToDate(startDate.add(period)) <
      +currentEraInfo.startTime + eraPeriod.mul(1000).toNumber()
    ) {
      await saveDatas();
      return;
    }
    // otherwise can use same process as the agreement has more than 1 era
  }

  await saveDatas(agreementFirstEraAmount);
  // minus first rate and then less than 1 indicates this agreement only have two era
  if (agreementLastEraNumbers.minus(agreementFirstEraRate).lte(1)) {
    const eraId = BigNumber.from(currentEra + 1);
    const leftAmount = BignumberJs(amount.toString()).minus(
      agreementFirstEraAmount
    );
    await saveDatas(leftAmount, eraId);
    return;
  }

  // if the agreement has more than 2 era
  const leftEra = agreementLastEraNumbers.minus(agreementFirstEraRate);
  const integerPart = leftEra.integerValue(BignumberJs.ROUND_DOWN);
  const decimalPart = leftEra.minus(integerPart);
  const decimalPartAmount = everyEraAmount.multipliedBy(decimalPart);
  const lastEra = leftEra.integerValue(BignumberJs.ROUND_CEIL);

  for (let index = 0; index < integerPart.toNumber(); index++) {
    await saveDatas(everyEraAmount, BigNumber.from(currentEra + index + 1));
  }

  await saveDatas(
    BignumberJs(decimalPartAmount.toFixed(0)),
    BigNumber.from(currentEra + lastEra.toNumber())
  );
}
