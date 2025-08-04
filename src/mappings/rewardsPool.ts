import assert from 'assert';
import { CollectEvent } from '@subql/contract-sdk/typechain/contracts/RewardsPool';
import { EthereumLog } from '@subql/types-ethereum';
import {
  ConsumerQuerySpent,
  EraDeploymentRewards,
  IndexerEraDeploymentRewards,
  OrderType,
} from '../types';
import { BigNumber } from 'ethers';
import { bytesToIpfsCid } from './utils';

// export async function addOrUpdateEraDeploymentRewards(
//   deploymentId: string,
//   eraIdx: number
// ): Promise<void> {
//   logger.info('addOrUpdateEraDeploymentRewards');
//   assert(deploymentId, 'No deploymentId');
//   assert(eraIdx, 'No eraIdx');

//   const aggregateResultFromIndexerEraDeploymentRewards =
//     await IndexerEraDeploymentRewards.getByFields(
//       [
//         ['deploymentId', '=', deploymentId],
//         ['eraIdx', '=', eraIdx],
//       ],
//       {}
//     );

//   const id = `${deploymentId}:${eraIdx}`;
//   const existingEraDeploymentRewards = await EraDeploymentRewards.get(id);

//   const eraDeploymentRewards = EraDeploymentRewards.create({
//     id,
//     deploymentId,
//     eraIdx,
//     totalRewards,
//     allocationRewards,
//     stateChannelRewards,
//     agreementRewards,
//     queryRewards: totalRewards - allocationRewards,
//     changesHeight: eventLog,
//   });
//   await eraDeploymentRewards.save();
// }

// note this function includes update IndexerEraDeployment & EraDeployment
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

  const updateEraDeployment = async () => {
    const existDeploymentId = `${deploymentId}:${eraIdx}`;
    const existingEraDeploymentRewards = await EraDeploymentRewards.get(
      existDeploymentId
    );

    const id = `${indexerId}:${deploymentId}:${eraIdx}`;
    const existingIndexerEraDeploymentRewards =
      await IndexerEraDeploymentRewards.get(id);

    if (existingEraDeploymentRewards) {
      if (overrideStateChannel) {
        const previouseStateChannelRewards =
          existingIndexerEraDeploymentRewards?.stateChannelRewards || BigInt(0);
        existingEraDeploymentRewards.stateChannelRewards -=
          previouseStateChannelRewards;
      }
      existingEraDeploymentRewards.stateChannelRewards += stateChannelRewards;
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

    if (!existingEraDeploymentRewards) {
      const eraDeploymentRewards = EraDeploymentRewards.create({
        id: existDeploymentId,
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
  };

  const updateIndexerEraDeployment = async () => {
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
      existingIndexerEraDeploymentRewards.allocationRewards +=
        allocationRewards;
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
  };

  await updateEraDeployment();
  await updateIndexerEraDeployment();
}

export async function addOrUpdateConsumerQuerySpent(
  consumer: string,
  runner: string,
  deploymentId: string,
  eraIdx: number,
  orderType: OrderType,
  orderId: string,
  spend: bigint,
  createAt: Date,
  eventLog: string = ''
) {
  const id = `${consumer}:${eraIdx}:${orderType}:${orderId}`;
  const exist = await ConsumerQuerySpent.get(id);
  if (exist) {
    exist.spend += spend;
    await exist.save();
    return;
  }
  const labor = ConsumerQuerySpent.create({
    id,
    consumer,
    indexerId: runner,
    deploymentId: bytesToIpfsCid(deploymentId),
    orderType,
    orderId,
    spend,
    eraIdx,
    createAt,
    changesHeight: eventLog,
  });

  await labor.save();
}

// reward pool collect literally only trigger once per era
export async function handleRewardsPoolCollect(
  event: EthereumLog<CollectEvent['args']>
): Promise<void> {
  logger.info('handleRewardsPoolCollect');
  assert(event.args, 'No event args');

  const { deploymentId, era, amount, runner } = event.args;

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
