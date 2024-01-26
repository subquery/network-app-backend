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
  DeploymentBooster,
  DeploymentBoosterSummary,
  IndexerAllocationReward,
  IndexerAllocationRewardSummary,
  OrderType,
  ServiceAgreement,
  StateChannel,
} from '../types';
import { biToDate } from './utils';
import { getCurrentEra } from './eraManager';
import { defaultAbiCoder } from 'ethers/lib/utils';

export async function handleDeploymentBoosterAdded(
  event: EthereumLog<DeploymentBoosterAddedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { deploymentId, account: consumer, amount: amountAdded } = event.args;

  const boosterId = `${deploymentId}:${consumer}:${event.transactionHash}`;

  let booster = await DeploymentBooster.get(boosterId);
  assert(!booster, 'Booster already exists');

  booster = DeploymentBooster.create({
    id: boosterId,
    deploymentId,
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
      deploymentId,
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
  assert(event.args, 'No event args');
  const { deploymentId, account: consumer, amount: amountRemoved } = event.args;

  const boosterId = `${deploymentId}:${consumer}:${event.transactionHash}`;
  let booster = await DeploymentBooster.get(boosterId);
  assert(!booster, 'Booster already exists');

  booster = DeploymentBooster.create({
    id: boosterId,
    deploymentId,
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
      deploymentId,
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
  assert(event.args, 'No event args');
  const { deploymentId, runner: indexerId, labor } = event.args;
}

export async function handleAllocationRewardsGiven(
  event: EthereumLog<AllocationRewardsGivenEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { deploymentId, runner: indexerId, amount: reward } = event.args;

  const rewardId = `${deploymentId}:${indexerId}:${event.transactionHash}`;
  let allocationReward = await IndexerAllocationReward.get(rewardId);
  assert(!allocationReward, 'Allocation reward already exists');

  allocationReward = IndexerAllocationReward.create({
    id: rewardId,
    deploymentId,
    indexerId,
    reward: reward.toBigInt(),
    burnt: BigInt(0),
    eraIdx: await getCurrentEra(),
    createAt: biToDate(event.block.timestamp),
  });
  await allocationReward.save();

  const summaryId = `${deploymentId}:${indexerId}`;
  let summary = await IndexerAllocationRewardSummary.get(summaryId);
  if (!summary) {
    summary = IndexerAllocationRewardSummary.create({
      id: summaryId,
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
}

export async function handleAllocationRewardsBurnt(
  event: EthereumLog<AllocationRewardsBurntEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { deploymentId, runner: indexerId, amount: burnt } = event.args;

  const rewardId = `${deploymentId}:${indexerId}:${event.transactionHash}`;
  let allocationReward = await IndexerAllocationReward.get(rewardId);
  assert(allocationReward, 'Allocation reward not found');

  allocationReward.burnt = burnt.toBigInt();
  await allocationReward.save();

  const summaryId = `${deploymentId}:${indexerId}`;
  let summary = await IndexerAllocationRewardSummary.get(summaryId);
  if (!summary) {
    summary = IndexerAllocationRewardSummary.create({
      id: summaryId,
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
  assert(event.args, 'No event args');
  const { deploymentId, runner: indexerId, amount: spent, data } = event.args;

  const address = defaultAbiCoder.decode(['address'], data)[0] as string;
  const agreement = await ServiceAgreement.get(address);
  const channel = await StateChannel.get(address);
  assert(agreement || channel, 'No agreement or channel found');

  let orderType: OrderType = OrderType.UNKNOWN;
  if (agreement) {
    orderType = OrderType.SERVICE_AGREEMENT;
  } else if (channel) {
    orderType = OrderType.STATE_CHANNEL;
  }

  const consumer = agreement?.consumerAddress || channel?.consumer || '';
  const rewardId = `${deploymentId}:${indexerId}:${orderType}:${address}`;
  let queryReward = await ConsumerQueryReward.get(rewardId);

  if (!queryReward) {
    queryReward = ConsumerQueryReward.create({
      id: rewardId,
      deploymentId,
      consumer,
      orderType,
      orderAddress: address,
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
  assert(event.args, 'No event args');
  const {
    deploymentId,
    runner: indexerId,
    amount: refunded,
    data,
  } = event.args;

  const address = defaultAbiCoder.decode(['address'], data)[0] as string;
  const agreement = await ServiceAgreement.get(address);
  const channel = await StateChannel.get(address);
  assert(agreement || channel, 'No agreement or channel found');

  let orderType: OrderType = OrderType.UNKNOWN;
  if (agreement) {
    orderType = OrderType.SERVICE_AGREEMENT;
  } else if (channel) {
    orderType = OrderType.STATE_CHANNEL;
  }

  const consumer = agreement?.consumerAddress || channel?.consumer || '';
  const rewardId = `${deploymentId}:${indexerId}:${orderType}:${address}`;
  let queryReward = await ConsumerQueryReward.get(rewardId);

  if (!queryReward) {
    queryReward = ConsumerQueryReward.create({
      id: rewardId,
      deploymentId,
      consumer,
      orderType,
      orderAddress: address,
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
