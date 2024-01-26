import { EthereumLog } from '@subql/types-ethereum';
import {
  OverAllocationEndedEvent,
  OverAllocationStartedEvent,
  StakeAllocationAddedEvent,
  StakeAllocationRemovedEvent,
} from '../types/contracts/StakingAllocation';
import assert from 'assert';
import { IndexerAllocation, IndexerAllocationSummary } from '../types';
import { biToDate } from './utils';
import { getCurrentEra } from './eraManager';

export async function handleStakeAllocationAdded(
  event: EthereumLog<StakeAllocationAddedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { deploymentId, runner: indexerId, amount: amountAdded } = event.args;

  const allocationId = `${deploymentId}:${indexerId}:${event.transactionHash}`;
  let allocation = await IndexerAllocation.get(allocationId);
  assert(!allocation, 'Allocation already exists');

  allocation = IndexerAllocation.create({
    id: allocationId,
    deploymentId,
    indexerId,
    amountAdded: amountAdded.toBigInt(),
    amountRemoved: BigInt(0),
    eraIdx: await getCurrentEra(),
    createAt: biToDate(event.block.timestamp),
  });
  await allocation.save();

  const summaryId = `${deploymentId}:${indexerId}`;
  let summary = await IndexerAllocationSummary.get(summaryId);
  if (!summary) {
    summary = IndexerAllocationSummary.create({
      id: summaryId,
      deploymentId,
      indexerId,
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

export async function handleStakeAllocationRemoved(
  event: EthereumLog<StakeAllocationRemovedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { deploymentId, runner: indexerId, amount: amountRemoved } = event.args;

  const allocationId = `${deploymentId}:${indexerId}:${event.transactionHash}`;
  let allocation = await IndexerAllocation.get(allocationId);
  assert(!allocation, 'Allocation already exists');

  allocation = IndexerAllocation.create({
    id: allocationId,
    deploymentId,
    indexerId,
    amountAdded: BigInt(0),
    amountRemoved: amountRemoved.toBigInt(),
    eraIdx: await getCurrentEra(),
    createAt: biToDate(event.block.timestamp),
  });
  await allocation.save();

  const summaryId = `${deploymentId}:${indexerId}`;
  let summary = await IndexerAllocationSummary.get(summaryId);
  if (!summary) {
    summary = IndexerAllocationSummary.create({
      id: summaryId,
      deploymentId,
      indexerId,
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

export async function handleOverAllocationStarted(
  event: EthereumLog<OverAllocationStartedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { runner, start } = event.args;
}

export async function handleOverAllocationEnded(
  event: EthereumLog<OverAllocationEndedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { runner, end, time } = event.args;
}
