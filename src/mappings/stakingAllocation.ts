import { EthereumLog } from '@subql/types-ethereum';
import {
  OverAllocationEndedEvent,
  OverAllocationStartedEvent,
  StakeAllocationAddedEvent,
  StakeAllocationRemovedEvent,
} from '../types/contracts/StakingAllocation';
import assert from 'assert';
import {
  IndexerAllocation,
  IndexerAllocationOverflow,
  IndexerAllocationSummary,
  IndexerLatestAllocationOverflow,
} from '../types';
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

  const latestOverflowId = `${runner}`;
  let latestOverflow = await IndexerLatestAllocationOverflow.get(
    latestOverflowId
  );
  assert(!latestOverflow, 'Latest overflow already exists');

  const overflowId = `${runner}:${event.transactionHash}`;
  let overflow = await IndexerAllocationOverflow.get(overflowId);
  assert(!overflow, 'Overflow already exists');

  overflow = IndexerAllocationOverflow.create({
    id: overflowId,
    indexerId: runner,
    overflowStart: biToDate(start.toBigInt()),
    overflowEnd: new Date(0),
    overflowTime: BigInt(0),
    eraIdxStart: await getCurrentEra(),
    eraIdxEnd: -1,
    createAt: biToDate(event.block.timestamp),
    updateAt: biToDate(event.block.timestamp),
  });
  await overflow.save();

  latestOverflow = IndexerLatestAllocationOverflow.create({
    id: latestOverflowId,
    overflowIdId: overflowId,
    createAt: biToDate(event.block.timestamp),
    updateAt: biToDate(event.block.timestamp),
  });
  await latestOverflow.save();
}

export async function handleOverAllocationEnded(
  event: EthereumLog<OverAllocationEndedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  const { runner, end, time } = event.args;

  const latestOverflowId = `${runner}`;
  const latestOverflow = await IndexerLatestAllocationOverflow.get(
    latestOverflowId
  );
  assert(latestOverflow, 'Latest overflow not found');

  const overflowId = latestOverflow.overflowIdId;
  const overflow = await IndexerAllocationOverflow.get(overflowId);
  assert(overflow, 'Overflow not found');

  overflow.overflowEnd = biToDate(end.toBigInt());
  overflow.overflowTime = time.toBigInt();
  overflow.eraIdxEnd = await getCurrentEra();
  overflow.updateAt = biToDate(event.block.timestamp);
  await overflow.save();

  await IndexerLatestAllocationOverflow.remove(latestOverflowId);
}
