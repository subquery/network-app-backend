// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CreateQueryEvent,
  StartIndexingEvent,
  StopIndexingEvent,
  UpdateDeploymentStatusEvent,
  UpdateIndexingStatusToReadyEvent,
  UpdateQueryDeploymentEvent,
  UpdateQueryMetadataEvent,
} from '@subql/contract-sdk/typechain/QueryRegistry';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { Deployment, DeploymentIndexer, Project, Status } from '../types';
import { biToDate, bytesToIpfsCid } from './utils';

function getDeploymentIndexerId(indexer: string, deploymentId: string): string {
  return `${indexer}:${deploymentId}`;
}

export async function handleNewQuery(
  event: EthereumLog<CreateQueryEvent['args']>
): Promise<void> {
  logger.info('handleNewQueryProject');
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
    totalReward: BigInt(0),
    updatedTimestamp: biToDate(event.block.timestamp),
    createdTimestamp: biToDate(event.block.timestamp),
    createdBlock: event.blockNumber,
  });

  await project.save();

  const deployment = Deployment.create({
    id: deploymentId,
    version: currentVersion,
    createdTimestamp: biToDate(event.block.timestamp),
    projectId,
    createdBlock: event.blockNumber,
  });

  await deployment.save();
}

export async function handleUpdateQueryMetadata(
  event: EthereumLog<UpdateQueryMetadataEvent['args']>
): Promise<void> {
  logger.info('handleUpdateQueryMetadata');
  assert(event.args, 'No event args');
  const queryId = event.args.queryId.toHexString();
  const project = await Project.get(queryId);

  assert(project, `Expected query (${queryId}) to exist`);

  project.metadata = bytesToIpfsCid(event.args.metadata);
  project.updatedTimestamp = biToDate(event.block.timestamp);
  project.lastEvent = `handleUpdateQueryMetadata:${event.blockNumber}`;

  await project.save();
}

export async function handleUpdateQueryDeployment(
  event: EthereumLog<UpdateQueryDeploymentEvent['args']>
): Promise<void> {
  logger.info('handleUpdateQueryDeployment');
  assert(event.args, 'No event args');
  const projectId = event.args.queryId.toHexString();
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const version = bytesToIpfsCid(event.args.version);

  const deployment = Deployment.create({
    id: deploymentId,
    version,
    createdTimestamp: biToDate(event.block.timestamp),
    projectId,
    createdBlock: event.blockNumber,
  });

  await deployment.save();

  const project = await Project.get(projectId);

  assert(project, `Expected query (${projectId}) to exist`);

  project.currentDeployment = deploymentId;
  project.currentVersion = version;
  project.updatedTimestamp = biToDate(event.block.timestamp);
  project.lastEvent = `handleUpdateQueryDeployment:${event.blockNumber}`;

  await project.save();
}

export async function handleStartIndexing(
  event: EthereumLog<StartIndexingEvent['args']>
): Promise<void> {
  logger.info('handleStartIndexing');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const indexer = DeploymentIndexer.create({
    id: getDeploymentIndexerId(event.args.indexer, deploymentId),
    indexerId: event.args.indexer,
    deploymentId: deploymentId,
    status: Status.INDEXING,
    createdBlock: event.blockNumber,
  });
  await indexer.save();
}

/**
 * NOTE: 8Jul 2022
 * Event order: handleStartIndexing -> handleIndexingReady
 */
export async function handleIndexingReady(
  event: EthereumLog<UpdateIndexingStatusToReadyEvent['args']>
): Promise<void> {
  logger.info('handleIndexingReady');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const id = getDeploymentIndexerId(event.args.indexer, deploymentId);
  const indexer = await DeploymentIndexer.get(id);
  assert(indexer, `No DeploymentIndexer found for ${id}`);

  indexer.status = Status.READY;
  indexer.timestamp = biToDate(event.block.timestamp);
  indexer.lastEvent = `handleIndexingReady:${event.blockNumber}`;

  await indexer.save();
}

export async function handleStopIndexing(
  event: EthereumLog<StopIndexingEvent['args']>
): Promise<void> {
  logger.info('handleStopIndexing');
  assert(event.args, 'No event args');
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const id = getDeploymentIndexerId(event.args.indexer, deploymentId);
  const indexer = await DeploymentIndexer.get(id);

  assert(indexer, `Expected deployment indexer (${id}) to exist`);
  indexer.status = Status.TERMINATED;
  indexer.lastEvent = `handleStopIndexing:${event.blockNumber}`;

  await indexer.save();

  // TODO remove indexer instead?
}
