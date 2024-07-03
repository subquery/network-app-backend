import assert from 'assert';
import { CollectEvent } from '@subql/contract-sdk/typechain/contracts/RewardsPool';
import { EthereumLog } from '@subql/types-ethereum';
import { EraDeploymentRewards } from '../types';
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
    await existingEraDeploymentRewards.save();
    return;
  }

  const eraDeploymentRewards = EraDeploymentRewards.create({
    id,
    deploymentId,
    eraIdx,
    totalRewards,
    allocationRewards,
  });
  await eraDeploymentRewards.save();
}

export async function handleRewardsPoolCollect(
  event: EthereumLog<CollectEvent['args']>
): Promise<void> {
  logger.info('handleRewardsPoolCollect');
  assert(event.args, 'No event args');

  const { deploymentId, era, amount } = event.args;
  await addOrUpdateEraDeploymentRewards(
    bytesToIpfsCid(deploymentId),
    era.toNumber(),
    amount.toBigInt(),
    BigNumber.from(0).toBigInt()
  );
}
