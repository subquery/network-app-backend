import { EthereumLog } from '@subql/types-ethereum';
import {
  AllocationRewardsBurntEvent,
  AllocationRewardsGivenEvent,
  DeploymentBoosterAddedEvent,
  DeploymentBoosterRemovedEvent,
  MissedLaborEvent,
  QueryRewardsRefundedEvent,
  QueryRewardsSpentEvent,
} from '../types/contracts/RewardsBooster';
import assert from 'assert';
import {
  ConsumerQueryReward,
  ConsumerQueryRewardSummary,
  Deployment,
  DeploymentBooster,
  DeploymentBoosterSummary,
  IndexerAllocationReward,
  IndexerAllocationRewardSummary,
  IndexerMissedLabor,
  OrderType,
  Project,
  ProjectType,
  ServiceAgreement,
  StateChannel,
} from '../types';
import { biToDate, bytesToIpfsCid } from './utils';
import { getCurrentEra } from './eraManager';
import { BigNumber } from 'ethers';
import { upsertEraIndexerDeploymentApy } from './rewardsDistributor';
import { RewardType } from './utils/enums';
import {
  addOrUpdateEraDeploymentRewards,
  addOrUpdateIndexerEraDeploymentRewards,
} from './rewardsPool';

const preboostedCids = [
  'Qmc9svij5SxCEGApMZzV9MwWgy8TuMTtGgsrWxR1yaUqZ9',
  'QmeBTNuhahUo2EhTRxV3qVAVf5bC8zVQRrrHd3SUDXgtbF',
];
const preboostedPids: any = {
  Qmc9svij5SxCEGApMZzV9MwWgy8TuMTtGgsrWxR1yaUqZ9: '0x21',
  QmeBTNuhahUo2EhTRxV3qVAVf5bC8zVQRrrHd3SUDXgtbF: '0x21',
};

export async function handleDeploymentBoosterAdded(
  event: EthereumLog<DeploymentBoosterAddedEvent['args']>
): Promise<void> {
  logger.info(`handleDeploymentBoosterAdded`);
  assert(event.args, 'No event args');
  const { account: consumer, amount: amountAdded } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  let deployment = await Deployment.get(deploymentId);
  if (!deployment && preboostedCids.includes(deploymentId)) {
    deployment = Deployment.create({
      id: deploymentId,
      metadata: '',
      projectId: preboostedPids[deploymentId],
      createdTimestamp: new Date(),
    });
  }
  assert(deployment, `Deployment ${deploymentId} not found`);

  let project = await Project.get(deployment.projectId);
  if (!project && preboostedCids.includes(deploymentId)) {
    project = Project.create({
      id: deployment.projectId,
      owner: '',
      type: ProjectType.SUBQUERY,
      metadata: '',
      deploymentId: '',
      deploymentMetadata: '',
      updatedTimestamp: new Date(),
      createdTimestamp: new Date(),
      totalReward: BigInt(0),
    });
  }
  assert(project, `Project ${deployment.projectId} not found`);

  const boosterId = `${deploymentId}:${consumer}:${event.transactionHash}:${event.logIndex}`;

  let booster = await DeploymentBooster.get(boosterId);
  assert(!booster, 'Booster already exists');

  booster = DeploymentBooster.create({
    id: boosterId,
    projectId: project.id,
    deploymentId: deployment.id,
    consumer,
    amountAdded: amountAdded.toBigInt(),
    amountRemoved: BigInt(0),
    eraIdx: await getCurrentEra(),
    createAt: biToDate(event.block.timestamp),
  });
  await booster.save();

  const summaryId = `${deploymentId}:${consumer}`;
  let summary = await DeploymentBoosterSummary.get(summaryId);
  if (!summary) {
    summary = DeploymentBoosterSummary.create({
      id: summaryId,
      projectId: project.id,
      deploymentId: deployment.id,
      consumer,
      totalAdded: amountAdded.toBigInt(),
      totalRemoved: BigInt(0),
      totalAmount: amountAdded.toBigInt(),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    summary.totalAdded += amountAdded.toBigInt();
    summary.totalAmount = summary.totalAdded - summary.totalRemoved;
    summary.updateAt = biToDate(event.block.timestamp);
  }
  await summary.save();
}

export async function handleDeploymentBoosterRemoved(
  event: EthereumLog<DeploymentBoosterRemovedEvent['args']>
): Promise<void> {
  logger.info(`handleDeploymentBoosterRemoved`);
  assert(event.args, 'No event args');
  const { account: consumer, amount: amountRemoved } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  const deployment = await Deployment.get(deploymentId);
  assert(deployment, `Deployment ${deploymentId} not found`);

  const project = await Project.get(deployment.projectId);
  assert(project, `Project ${deployment.projectId} not found`);

  const boosterId = `${deploymentId}:${consumer}:${event.transactionHash}:${event.logIndex}`;
  let booster = await DeploymentBooster.get(boosterId);
  assert(!booster, 'Booster already exists');

  booster = DeploymentBooster.create({
    id: boosterId,
    projectId: project.id,
    deploymentId: deployment.id,
    consumer: consumer,
    amountAdded: BigInt(0),
    amountRemoved: amountRemoved.toBigInt(),
    eraIdx: await getCurrentEra(),
    createAt: biToDate(event.block.timestamp),
  });
  await booster.save();

  const summaryId = `${deploymentId}:${consumer}`;
  let summary = await DeploymentBoosterSummary.get(summaryId);
  if (!summary) {
    summary = DeploymentBoosterSummary.create({
      id: summaryId,
      projectId: project.id,
      deploymentId: deployment.id,
      consumer: consumer,
      totalAdded: BigInt(0),
      totalRemoved: amountRemoved.toBigInt(),
      totalAmount: BigInt(0),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    summary.totalRemoved += amountRemoved.toBigInt();
    summary.totalAmount = summary.totalAdded - summary.totalRemoved;
    summary.updateAt = biToDate(event.block.timestamp);
  }
  await summary.save();
}

export async function handleMissedLabor(
  event: EthereumLog<MissedLaborEvent['args']>
): Promise<void> {
  logger.info(`handleMissedLabor`);
  assert(event.args, 'No event args');
  const { runner: indexerId, labor } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  const missedLaborId = `${deploymentId}:${indexerId}:${event.transactionHash}:${event.logIndex}`;
  let missedLabor = await IndexerMissedLabor.get(missedLaborId);
  assert(!missedLabor, 'Missed labor already exists');

  missedLabor = IndexerMissedLabor.create({
    id: missedLaborId,
    deploymentId,
    indexerId,
    missedLabor: labor.toBigInt(),
    eraIdx: await getCurrentEra(),
    createAt: biToDate(event.block.timestamp),
  });
  await missedLabor.save();
}

export async function handleAllocationRewardsGiven(
  event: EthereumLog<AllocationRewardsGivenEvent['args']>
): Promise<void> {
  logger.info(`handleAllocationRewardsGiven`);
  assert(event.args, 'No event args');
  const { runner: indexerId, amount: reward } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  const deployment = await Deployment.get(deploymentId);
  assert(deployment, `Deployment ${deploymentId} not found`);

  const project = await Project.get(deployment.projectId);
  assert(project, `Project ${deployment.projectId} not found`);

  const rewardId = `${deploymentId}:${indexerId}:${event.transactionHash}:${event.logIndex}`;
  let allocationReward = await IndexerAllocationReward.get(rewardId);
  assert(!allocationReward, 'Allocation reward already exists');

  const eraIdx = await getCurrentEra();

  // add allocation to era deployment
  await addOrUpdateEraDeploymentRewards(
    deploymentId,
    eraIdx,
    reward.toBigInt(),
    reward.toBigInt()
  );

  await addOrUpdateIndexerEraDeploymentRewards(
    indexerId,
    deploymentId,
    eraIdx,
    reward.toBigInt(),
    reward.toBigInt()
  );

  allocationReward = IndexerAllocationReward.create({
    id: rewardId,
    projectId: project.id,
    deploymentId,
    indexerId,
    reward: reward.toBigInt(),
    burnt: BigInt(0),
    eraIdx,
    createAt: biToDate(event.block.timestamp),
  });
  await allocationReward.save();

  const summaryId = `${deploymentId}:${indexerId}`;
  let summary = await IndexerAllocationRewardSummary.get(summaryId);
  if (!summary) {
    summary = IndexerAllocationRewardSummary.create({
      id: summaryId,
      projectId: project.id,
      deploymentId,
      indexerId,
      totalReward: reward.toBigInt(),
      totalBurnt: BigInt(0),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    summary.totalReward += reward.toBigInt();
    summary.updateAt = biToDate(event.block.timestamp);
  }
  await summary.save();

  project.totalReward += reward.toBigInt();
  await project.save();

  await upsertEraIndexerDeploymentApy(
    indexerId,
    deploymentId,
    eraIdx,
    RewardType.ALLOCATION,
    reward.toBigInt(),
    BigInt(0),
    biToDate(event.block.timestamp)
  );
}

export async function handleAllocationRewardsBurnt(
  event: EthereumLog<AllocationRewardsBurntEvent['args']>
): Promise<void> {
  logger.info(`handleAllocationRewardsBurnt`);
  assert(event.args, 'No event args');
  const { runner: indexerId, amount: burnt } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  const deployment = await Deployment.get(deploymentId);
  assert(deployment, `Deployment ${deploymentId} not found`);

  const project = await Project.get(deployment.projectId);
  assert(project, `Project ${deployment.projectId} not found`);

  const rewardId = `${deploymentId}:${indexerId}:${event.transactionHash}:${event.logIndex}`;
  let allocationReward = await IndexerAllocationReward.get(rewardId);
  if (!allocationReward) {
    allocationReward = IndexerAllocationReward.create({
      id: rewardId,
      projectId: project.id,
      deploymentId,
      indexerId,
      reward: BigInt(0),
      burnt: burnt.toBigInt(),
      eraIdx: await getCurrentEra(),
      createAt: biToDate(event.block.timestamp),
    });
    await allocationReward.save();
  }

  allocationReward.burnt = burnt.toBigInt();
  await allocationReward.save();

  const summaryId = `${deploymentId}:${indexerId}`;
  let summary = await IndexerAllocationRewardSummary.get(summaryId);
  if (!summary) {
    summary = IndexerAllocationRewardSummary.create({
      id: summaryId,
      projectId: project.id,
      deploymentId,
      indexerId,
      totalReward: BigInt(0),
      totalBurnt: burnt.toBigInt(),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    summary.totalBurnt += burnt.toBigInt();
    summary.updateAt = biToDate(event.block.timestamp);
  }
  await summary.save();
}

export async function handleQueryRewardsSpent(
  event: EthereumLog<QueryRewardsSpentEvent['args']>
): Promise<void> {
  logger.info(`handleQueryRewardsSpent`);
  assert(event.args, 'No event args');
  const { spender: consumer, amount: spent, data } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  const deployment = await Deployment.get(deploymentId);
  assert(deployment, `Deployment ${deploymentId} not found`);

  const project = await Project.get(deployment.projectId);
  assert(project, `Project ${deployment.projectId} not found`);

  logger.info(`handleQueryRewardsSpent orderId [data]: ${data}`);

  const agreement = await ServiceAgreement.get(BigNumber.from(data).toString());
  const channel = await StateChannel.get(BigNumber.from(data).toHexString());
  assert(agreement || channel, 'No agreement or channel found');

  let orderType: OrderType = OrderType.UNKNOWN;
  let orderId = '';
  if (agreement) {
    orderType = OrderType.SERVICE_AGREEMENT;
    orderId = agreement.id;
  } else if (channel) {
    orderType = OrderType.STATE_CHANNEL;
    orderId = channel.id;
  }

  const rewardId = `${deploymentId}:${consumer}:${orderType}:${orderId}`;
  let queryReward = await ConsumerQueryReward.get(rewardId);

  if (!queryReward) {
    queryReward = ConsumerQueryReward.create({
      id: rewardId,
      projectId: project.id,
      deploymentId,
      consumer,
      orderType,
      orderId,
      spent: spent.toBigInt(),
      refunded: BigInt(0),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    queryReward.spent += spent.toBigInt();
    queryReward.updateAt = biToDate(event.block.timestamp);
  }
  await queryReward.save();

  const summaryId = `${deploymentId}:${consumer}:${orderType}`;
  let summary = await ConsumerQueryRewardSummary.get(summaryId);
  if (!summary) {
    summary = ConsumerQueryRewardSummary.create({
      id: summaryId,
      projectId: project.id,
      deploymentId,
      consumer,
      orderType,
      totalSpent: spent.toBigInt(),
      totalRefunded: BigInt(0),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    summary.totalSpent += spent.toBigInt();
    summary.updateAt = biToDate(event.block.timestamp);
  }
  await summary.save();
}

export async function handleQueryRewardsRefunded(
  event: EthereumLog<QueryRewardsRefundedEvent['args']>
): Promise<void> {
  logger.info(`handleQueryRewardsRefunded`);
  assert(event.args, 'No event args');
  const { spender: consumer, amount: refunded, data } = event.args;
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);

  const deployment = await Deployment.get(deploymentId);
  assert(deployment, `Deployment ${deploymentId} not found`);

  const project = await Project.get(deployment.projectId);
  assert(project, `Project ${deployment.projectId} not found`);

  logger.info(`handleQueryRewardsRefunded orderId [data]: ${data}`);

  const agreement = await ServiceAgreement.get(BigNumber.from(data).toString());
  const channel = await StateChannel.get(BigNumber.from(data).toHexString());
  assert(agreement || channel, 'No agreement or channel found');

  let orderType: OrderType = OrderType.UNKNOWN;
  let orderId = '';
  if (agreement) {
    orderType = OrderType.SERVICE_AGREEMENT;
    orderId = agreement.id;
  } else if (channel) {
    orderType = OrderType.STATE_CHANNEL;
    orderId = channel.id;
  }

  const rewardId = `${deploymentId}:${consumer}:${orderType}:${orderId}`;
  let queryReward = await ConsumerQueryReward.get(rewardId);

  if (!queryReward) {
    queryReward = ConsumerQueryReward.create({
      id: rewardId,
      projectId: project.id,
      deploymentId,
      consumer,
      orderType,
      orderId,
      spent: BigInt(0),
      refunded: refunded.toBigInt(),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    queryReward.refunded += refunded.toBigInt();
    queryReward.updateAt = biToDate(event.block.timestamp);
  }
  await queryReward.save();

  const summaryId = `${deploymentId}:${consumer}:${orderType}`;
  let summary = await ConsumerQueryRewardSummary.get(summaryId);
  if (!summary) {
    summary = ConsumerQueryRewardSummary.create({
      id: summaryId,
      projectId: project.id,
      deploymentId,
      consumer,
      orderType,
      totalSpent: BigInt(0),
      totalRefunded: refunded.toBigInt(),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    summary.totalRefunded += refunded.toBigInt();
    summary.updateAt = biToDate(event.block.timestamp);
  }
  await summary.save();
}
