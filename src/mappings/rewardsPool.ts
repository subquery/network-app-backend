import assert from 'assert';
import { CollectEvent } from '@subql/contract-sdk/typechain/contracts/RewardsPool';
import { EthereumLog } from '@subql/types-ethereum';
import { EraDeploymentRewards, IndexerEraDeploymentRewards } from '../types';
import { BigNumber } from 'ethers';
import { bytesToIpfsCid } from './utils';

export async function addOrUpdateEraDeploymentRewards(
  deploymentId: string,
  eraIdx: number,
  totalRewards: bigint,
  allocationRewards: bigint
): Promise<void> {
  logger.info('addOrUpdateEraDeploymentRewards');
  assert(deploymentId, 'No deploymentId');
  assert(eraIdx, 'No eraIdx');

  const id = `${deploymentId}:${eraIdx}`;
  const existingEraDeploymentRewards = await EraDeploymentRewards.get(id);
  if (existingEraDeploymentRewards) {
    existingEraDeploymentRewards.totalRewards += totalRewards;
    existingEraDeploymentRewards.allocationRewards += allocationRewards;
    existingEraDeploymentRewards.queryRewards =
      existingEraDeploymentRewards.totalRewards -
      existingEraDeploymentRewards.allocationRewards;
    await existingEraDeploymentRewards.save();
    return;
  }

  const eraDeploymentRewards = EraDeploymentRewards.create({
    id,
    deploymentId,
    eraIdx,
    totalRewards,
    allocationRewards,
    queryRewards: totalRewards - allocationRewards,
  });
  await eraDeploymentRewards.save();
}

export async function addOrUpdateIndexerEraDeploymentRewards(
  indexerId: string,
  deploymentId: string,
  eraIdx: number,
  totalRewards: bigint,
  allocationRewards: bigint
) {
  logger.info('addOrUpdateIndexerEraDeploymentRewards');
  assert(deploymentId, 'No deploymentId');
  assert(eraIdx, 'No eraIdx');
  assert(indexerId, 'No indexerId');

  const id = `${indexerId}:${deploymentId}:${eraIdx}`;
  const existingIndexerEraDeploymentRewards =
    await IndexerEraDeploymentRewards.get(id);
  if (existingIndexerEraDeploymentRewards) {
    existingIndexerEraDeploymentRewards.totalRewards += totalRewards;
    existingIndexerEraDeploymentRewards.allocationRewards += allocationRewards;
    existingIndexerEraDeploymentRewards.queryRewards =
      existingIndexerEraDeploymentRewards.totalRewards -
      existingIndexerEraDeploymentRewards.allocationRewards;
    await existingIndexerEraDeploymentRewards.save();
    return;
  }

  const eraDeploymentRewards = IndexerEraDeploymentRewards.create({
    id,
    indexerId,
    deploymentId,
    eraIdx,
    totalRewards,
    allocationRewards,
    queryRewards: totalRewards - allocationRewards,
  });
  await eraDeploymentRewards.save();
}

// this function have deprecated, keep it to collect historical data.
export async function handleRewardsPoolCollect(
  event: EthereumLog<CollectEvent['args']>
): Promise<void> {
  logger.info('handleRewardsPoolCollect');
  assert(event.args, 'No event args');

  const { deploymentId, era, amount, runner } = event.args;
  await addOrUpdateEraDeploymentRewards(
    bytesToIpfsCid(deploymentId),
    era.toNumber(),
    amount.toBigInt(),
    BigNumber.from(0).toBigInt()
  );

  await addOrUpdateIndexerEraDeploymentRewards(
    runner,
    bytesToIpfsCid(deploymentId),
    era.toNumber(),
    amount.toBigInt(),
    BigNumber.from(0).toBigInt()
  );
}
