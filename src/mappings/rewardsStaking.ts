import { TypedEvent } from '@subql/contract-sdk/typechain/common';
import { EthereumLog, EthereumResult } from '@subql/types-ethereum';
import { BigNumber } from 'ethers';
import { IndexerStakeWeight } from '../types';
import { biToDate } from './utils';
import { getCurrentEra } from './eraManager';

// TODO: this is a temporary solution to avoid type errors
export interface RunnerWeightAppliedEventObject {
  runner: string;
  weight: BigNumber;
}
export declare type RunnerWeightAppliedEvent = TypedEvent<
  [string, BigNumber],
  RunnerWeightAppliedEventObject
> extends EthereumResult
  ? RunnerWeightAppliedEventObject
  : never;

export async function handleRunnerWeightApplied(
  event: EthereumLog<RunnerWeightAppliedEvent>
) {
  logger.info(`handleRunnerWeightApplied`);
  // TODO: this is a temporary solution to avoid type errors
  // const { runner: indexer, weight } = event.args;
  const indexer = '';
  const weight = BigInt(0);

  const eraIdx = await getCurrentEra();

  let indexerStakeWeight = await IndexerStakeWeight.get(indexer);
  if (!indexerStakeWeight) {
    indexerStakeWeight = IndexerStakeWeight.create({
      id: indexer,
      indexerId: indexer,
      eraIdx,
      weight,
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  }
  indexerStakeWeight.eraIdx = eraIdx;
  indexerStakeWeight.weight = weight;
  indexerStakeWeight.updateAt = biToDate(event.block.timestamp);
  await indexerStakeWeight.save();
}
