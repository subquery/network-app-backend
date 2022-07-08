// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import { DeploymentIndexer, Deployment, Project, Status } from '../types';
import { QueryRegistry__factory } from '@subql/contract-sdk';
import {
  CreateQueryEvent,
  StartIndexingEvent,
  UpdateDeploymentStatusEvent,
  StopIndexingEvent,
  UpdateQueryMetadataEvent,
  UpdateQueryDeploymentEvent,
  UpdateIndexingStatusToReadyEvent,
} from '@subql/contract-sdk/typechain/QueryRegistry';
import {
  bnToDate,
  bytesToIpfsCid,
  cidToBytes32,
  QUERY_REGISTRY_ADDRESS,
} from './utils';
import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import FrontierEthProvider from './ethProvider';

function getDeploymentIndexerId(indexer: string, deploymentId: string): string {
  return `${indexer}:${deploymentId}`;
}

interface ISaveDeploymentIndexer {
  indexerId: string;
  deploymentId: string;
  blockHeight?: bigint;
  timestamp?: Date;
  mmrRoot?: string;
  status: Status;
}

async function createDeploymentIndexer({
  indexerId,
  deploymentId,
  blockHeight,
  timestamp,
  mmrRoot,
  status,
}: ISaveDeploymentIndexer) {
  logger.info(`createDeploymentIndexer: ${indexerId}`);
  const sortedBlockHeight = blockHeight || BigInt(0);

  // try {
  //   if (!blockHeight) {
  //     const queryRegistryManager = QueryRegistry__factory.connect(
  //       QUERY_REGISTRY_ADDRESS,
  //       new FrontierEthProvider()
  //     );

  //     const deploymentStatus =
  //       await queryRegistryManager.deploymentStatusByIndexer(
  //         cidToBytes32(deploymentId),
  //         indexerId
  //       );

  //     logger.info(
  //       `====== deploymentStatus: ${deploymentStatus?.blockHeight.toBigInt()}`
  //     );

  //     sortedBlockHeight = deploymentStatus.blockHeight.toBigInt();
  //   }
  // } catch (error) {
  //   logger.error(error);
  //   throw Error(error);
  // }

  const indexer = DeploymentIndexer.create({
    id: getDeploymentIndexerId(indexerId, deploymentId),
    indexerId,
    deploymentId: deploymentId,
    blockHeight: sortedBlockHeight,
    timestamp,
    mmrRoot,
    status,
  });
  await indexer.save();
}

export async function handleNewQuery(
  event: AcalaEvmEvent<CreateQueryEvent['args']>
): Promise<void> {
  logger.info('handleNewQuery');
  assert(event.args, 'No event args');

  const projectId = event.args.queryId.toHexString();
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const currentVersion = bytesToIpfsCid(event.args.version);

  const project = Project.create({
    id: projectId,
    owner: event.args.creator,
    metadata: bytesToIpfsCid(event.args.metadata),
    currentDeployment: deploymentId,
    currentVersion,
    updatedTimestamp: event.blockTimestamp,
    createdTimestamp: event.blockTimestamp,
  });

  await project.save();

  const deployment = Deployment.create({
    id: deploymentId,
    version: currentVersion,
    createdTimestamp: event.blockTimestamp,
    projectId,
  });

  await deployment.save();
}

export async function handleUpdateQueryMetadata(
  event: AcalaEvmEvent<UpdateQueryMetadataEvent['args']>
): Promise<void> {
  logger.info('handleUpdateQueryMetadata');
  assert(event.args, 'No event args');
  const queryId = event.args.queryId.toHexString();
  const project = await Project.get(queryId);

  assert(project, `Expected query (${queryId}) to exist`);

  project.metadata = bytesToIpfsCid(event.args.metadata);
  project.updatedTimestamp = event.blockTimestamp;

  await project.save();
}

export async function handleUpdateQueryDeployment(
  event: AcalaEvmEvent<UpdateQueryDeploymentEvent['args']>
): Promise<void> {
  logger.info('handleUpdateQueryDeployment');
  assert(event.args, 'No event args');
  const projectId = event.args.queryId.toHexString();
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const version = bytesToIpfsCid(event.args.version);

  const deployment = Deployment.create({
    id: deploymentId,
    version,
    createdTimestamp: event.blockTimestamp,
    projectId,
  });

  await deployment.save();

  const project = await Project.get(projectId);

  assert(project, `Expected query (${projectId}) to exist`);

  project.currentDeployment = deploymentId;
  project.currentVersion = version;
  project.updatedTimestamp = event.blockTimestamp;

  await project.save();
}

export async function handleStartIndexing(
  event: AcalaEvmEvent<StartIndexingEvent['args']>
): Promise<void> {
  logger.info('handleStartIndexing');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const indexer = DeploymentIndexer.create({
    id: getDeploymentIndexerId(event.args.indexer, deploymentId),
    indexerId: event.args.indexer,
    deploymentId: deploymentId,
    blockHeight: BigInt(0),
    status: Status.INDEXING,
  });
  await indexer.save();
}

/**
 * NOTE: 8Jul 2022
 * Event order: handleIndexingReady -> handleIndexingUpdate
 */
export async function handleIndexingUpdate(
  event: AcalaEvmEvent<UpdateDeploymentStatusEvent['args']>
): Promise<void> {
  logger.info('handleIndexingUpdate');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const id = getDeploymentIndexerId(event.args.indexer, deploymentId);
  const indexer = await DeploymentIndexer.get(id);

  if (!indexer) {
    await createDeploymentIndexer({
      indexerId: id,
      deploymentId,
      blockHeight: event.args.blockheight.toBigInt(),
      mmrRoot: event.args.mmrRoot,
      timestamp: event.blockTimestamp,
      status: Status.READY,
    });
  } else {
    indexer.blockHeight = event.args.blockheight.toBigInt();
    indexer.mmrRoot = event.args.mmrRoot;
    indexer.timestamp = bnToDate(event.args.timestamp);
    await indexer.save();
  }
}

/**
 * NOTE: 8Jul 2022
 * Event order: handleStartIndexing -> handleIndexingReady
 */
export async function handleIndexingReady(
  event: AcalaEvmEvent<UpdateIndexingStatusToReadyEvent['args']>
): Promise<void> {
  logger.info('handleIndexingReady');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const id = getDeploymentIndexerId(event.args.indexer, deploymentId);
  const indexer = await DeploymentIndexer.get(id);

  if (!indexer) {
    await createDeploymentIndexer({
      indexerId: id,
      deploymentId,
      timestamp: event.blockTimestamp,
      status: Status.READY,
    });
  } else {
    indexer.status = Status.READY;
    indexer.timestamp = event.blockTimestamp;
    await indexer.save();
  }
}

export async function handleStopIndexing(
  event: AcalaEvmEvent<StopIndexingEvent['args']>
): Promise<void> {
  logger.info('handleStopIndexing');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const id = getDeploymentIndexerId(event.args.indexer, deploymentId);
  const indexer = await DeploymentIndexer.get(id);

  assert(indexer, `Expected deployment indexer (${id}) to exist`);
  indexer.status = Status.TERMINATED;
  await indexer.save();

  // TODO remove indexer instead?
}
