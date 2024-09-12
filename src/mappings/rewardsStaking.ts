import assert from 'assert';
import { EthereumLog } from '@subql/types-ethereum';
import { Indexer, IndexerStakeWeight } from '../types';
import { biToDate } from './utils';
import { getCurrentEra } from './eraManager';
import {
  RunnerWeightAppliedEvent,
  SettledEraUpdatedEvent,
} from '@subql/contract-sdk/typechain/contracts/RewardsStaking';

export async function handleRunnerWeightApplied(
  event: EthereumLog<RunnerWeightAppliedEvent['args']>
) {
  logger.info(`handleRunnerWeightApplied`);
  assert(event.args, 'No event args');
  const { runner: indexer, weight } = event.args;

  const eraIdx = await getCurrentEra();

  let indexerStakeWeight = await IndexerStakeWeight.get(indexer);
  if (!indexerStakeWeight) {
    indexerStakeWeight = IndexerStakeWeight.create({
      id: indexer,
      indexerId: indexer,
      eraIdx,
      weight: weight.toBigInt(),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  }
  indexerStakeWeight.eraIdx = eraIdx;
  indexerStakeWeight.weight = weight.toBigInt();
  indexerStakeWeight.updateAt = biToDate(event.block.timestamp);
  await indexerStakeWeight.save();
}

export async function handleSettledEraUpdated(
  event: EthereumLog<SettledEraUpdatedEvent['args']>
) {
  logger.info(`handleSettledEraUpdated`);
  assert(event.args, 'No event args');

  const { runner, era } = event.args;

  const existIndexer = await Indexer.get(runner);
  if (!existIndexer) {
    throw new Error(`Indexer ${runner} not found`);
  }

  existIndexer.lastSettledEra = era.toString();
  await existIndexer.save();
}
