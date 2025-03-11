import assert from 'assert';
import { CollectEvent } from '@subql/contract-sdk/typechain/contracts/RewardsPool';
import { EthereumLog } from '@subql/types-ethereum';
import { EraDeploymentRewards, IndexerEraDeploymentRewards } from '../types';
import { BigNumber } from 'ethers';
import { bytesToIpfsCid } from './utils';

export async function addOrUpdateEraDeploymentRewards(
  deploymentId: string,
  eraIdx: number,
  stateChannelRewards: bigint,
  allocationRewards: bigint,
  agreementRewards: bigint,
  eventLog: string = '',
  overrideStateChannelRewards?: boolean // it's for rewardsPool collect query rewards, if set be true, totalRewards will be override to totalRewards, not
): Promise<void> {
  logger.info('addOrUpdateEraDeploymentRewards');
  assert(deploymentId, 'No deploymentId');
  assert(eraIdx, 'No eraIdx');

  const id = `${deploymentId}:${eraIdx}`;
  const existingEraDeploymentRewards = await EraDeploymentRewards.get(id);
  if (existingEraDeploymentRewards) {
    if (overrideStateChannelRewards) {
      existingEraDeploymentRewards.stateChannelRewards = stateChannelRewards;
    } else {
      existingEraDeploymentRewards.stateChannelRewards += stateChannelRewards;
    }
    existingEraDeploymentRewards.agreementRewards += agreementRewards;
    existingEraDeploymentRewards.allocationRewards += allocationRewards;
    existingEraDeploymentRewards.totalRewards =
      existingEraDeploymentRewards.stateChannelRewards +
      existingEraDeploymentRewards.agreementRewards +
      existingEraDeploymentRewards.allocationRewards;
    existingEraDeploymentRewards.queryRewards =
      existingEraDeploymentRewards.totalRewards -
      existingEraDeploymentRewards.allocationRewards;
    existingEraDeploymentRewards.changesHeight = `${existingEraDeploymentRewards.changesHeight},${eventLog}`;
    await existingEraDeploymentRewards.save();
    return;
  }

  const totalRewards =
    stateChannelRewards + allocationRewards + agreementRewards;

  const eraDeploymentRewards = EraDeploymentRewards.create({
    id,
    deploymentId,
    eraIdx,
    totalRewards,
    allocationRewards,
    stateChannelRewards,
    agreementRewards,
    queryRewards: totalRewards - allocationRewards,
    changesHeight: eventLog,
  });
  await eraDeploymentRewards.save();
}

export async function addOrUpdateIndexerEraDeploymentRewards(
  indexerId: string,
  deploymentId: string,
  eraIdx: number,
  stateChannelRewards: bigint,
  allocationRewards: bigint,
  agreementRewards: bigint,
  eventLog: string = '',
  overrideStateChannel?: boolean // it's for rewardsPool collect query rewards, if set be true, totalRewards will be override to totalRewards, not
) {
  logger.info('addOrUpdateIndexerEraDeploymentRewards');
  assert(deploymentId, 'No deploymentId');
  assert(eraIdx, 'No eraIdx');
  assert(indexerId, 'No indexerId');

  const id = `${indexerId}:${deploymentId}:${eraIdx}`;
  const existingIndexerEraDeploymentRewards =
    await IndexerEraDeploymentRewards.get(id);
  if (existingIndexerEraDeploymentRewards) {
    if (overrideStateChannel) {
      existingIndexerEraDeploymentRewards.stateChannelRewards =
        stateChannelRewards;
    } else {
      existingIndexerEraDeploymentRewards.stateChannelRewards +=
        stateChannelRewards;
    }
    existingIndexerEraDeploymentRewards.agreementRewards += agreementRewards;
    existingIndexerEraDeploymentRewards.allocationRewards += allocationRewards;
    existingIndexerEraDeploymentRewards.totalRewards =
      existingIndexerEraDeploymentRewards.stateChannelRewards +
      existingIndexerEraDeploymentRewards.agreementRewards +
      existingIndexerEraDeploymentRewards.allocationRewards;
    existingIndexerEraDeploymentRewards.queryRewards =
      existingIndexerEraDeploymentRewards.totalRewards -
      existingIndexerEraDeploymentRewards.allocationRewards;
    existingIndexerEraDeploymentRewards.changesHeight = `${existingIndexerEraDeploymentRewards.changesHeight},${eventLog}`;
    await existingIndexerEraDeploymentRewards.save();
    return;
  }

  const totalRewards =
    stateChannelRewards + allocationRewards + agreementRewards;
  const eraDeploymentRewards = IndexerEraDeploymentRewards.create({
    id,
    indexerId,
    deploymentId,
    eraIdx,
    totalRewards,
    allocationRewards,
    stateChannelRewards,
    agreementRewards,
    queryRewards: totalRewards - allocationRewards,
    changesHeight: eventLog,
  });
  await eraDeploymentRewards.save();
}

// reward pool collect literally only trigger once per era
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
    BigNumber.from(0).toBigInt(),
    BigNumber.from(0).toBigInt(),
    `rewardsPoolCollect:${event.blockNumber}`,
    true
  );

  await addOrUpdateIndexerEraDeploymentRewards(
    runner,
    bytesToIpfsCid(deploymentId),
    era.toNumber(),
    amount.toBigInt(),
    BigNumber.from(0).toBigInt(),
    BigNumber.from(0).toBigInt(),
    `rewardsPoolCollect:${event.blockNumber}`,
    true
  );
}
