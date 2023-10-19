// Copyright 2020-2022 SubProject Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CreateProjectEvent,
  ServiceStatusChangedEvent,
  TransferEvent,
  UpdateProjectDeploymentEvent,
  UpdateProjectMetadataEvent,
} from '@subql/contract-sdk/typechain/ProjectRegistry';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import {
  Deployment,
  IndexerDeployment,
  Project,
  ProjectType,
  ServiceStatus,
} from '../types';
import { biToDate, bytesToIpfsCid } from './utils';

function getIndexerDeploymentId(indexer: string, deploymentId: string): string {
  return `${indexer}:${deploymentId}`;
}

export async function handleNewProject(
  event: EthereumLog<CreateProjectEvent['args']>
): Promise<void> {
  logger.info('handleNewProjectProject');
  assert(event.args, 'No event args');

  const {
    creator,
    projectId,
    projectMetadata,
    projectType,
    deploymentId,
    deploymentMetadata,
  } = event.args;
  const type = projectType as unknown as ProjectType;

  const project = Project.create({
    id: projectId.toHexString(),
    owner: creator,
    type,
    metadata: projectMetadata,
    deploymentId: bytesToIpfsCid(deploymentId),
    deploymentMetadata: bytesToIpfsCid(deploymentMetadata),
    updatedTimestamp: biToDate(event.block.timestamp),
    createdTimestamp: biToDate(event.block.timestamp),
    createdBlock: event.blockNumber,
  });

  await project.save();

  const deployment = Deployment.create({
    id: deploymentId,
    metadata: deploymentMetadata,
    createdTimestamp: biToDate(event.block.timestamp),
    projectId: projectId.toHexString(),
    createdBlock: event.blockNumber,
  });

  await deployment.save();
}

export async function handlerProjectTransferred(
  event: EthereumLog<TransferEvent['args']>
): Promise<void> {
  logger.info('handlerProjectTransferred');
  assert(event.args, 'No event args');

  const { from, to, tokenId } = event.args;

  const project = await Project.get(tokenId.toHexString());
  assert(project, `Expected query (${tokenId}) to exist`);
  assert(project.owner === from, `Expected owner to be ${from}`);

  project.owner = to;
  project.updatedTimestamp = biToDate(event.block.timestamp);
  project.lastEvent = `handlerProjectTransferred:${event.blockNumber}`;

  await project.save();
}

export async function handleUpdateProjectMetadata(
  event: EthereumLog<UpdateProjectMetadataEvent['args']>
): Promise<void> {
  logger.info('handleUpdateProjectMetadata');
  assert(event.args, 'No event args');

  const { projectId, metadata } = event.args;
  const project = await Project.get(projectId.toHexString());

  assert(project, `Expected query (${projectId}) to exist`);

  project.metadata = bytesToIpfsCid(metadata);
  project.updatedTimestamp = biToDate(event.block.timestamp);
  project.lastEvent = `handleUpdateProjectMetadata:${event.blockNumber}`;

  await project.save();
}

export async function handleUpdateProjectDeployment(
  event: EthereumLog<UpdateProjectDeploymentEvent['args']>
): Promise<void> {
  logger.info('handleUpdateProjectDeployment');
  assert(event.args, 'No event args');

  const projectId = event.args.projectId.toHexString();
  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const metadata = bytesToIpfsCid(event.args.metadata);
  const timestamp = biToDate(event.block.timestamp);

  const deployment = Deployment.create({
    id: deploymentId,
    metadata,
    projectId,
    createdTimestamp: timestamp,
    createdBlock: event.blockNumber,
  });

  await deployment.save();

  const project = await Project.get(projectId);

  assert(project, `Expected query (${projectId}) to exist`);

  project.deploymentId = deploymentId;
  project.deploymentMetadata = metadata;
  project.updatedTimestamp = timestamp;
  project.lastEvent = `handleUpdateProjectDeployment:${event.blockNumber}`;

  await project.save();
}

export async function handleServiceStatusChanged(
  event: EthereumLog<ServiceStatusChangedEvent['args']>
): Promise<void> {
  logger.info('handleStartIndexing');
  assert(event.args, 'No event args');

  const deploymentId = bytesToIpfsCid(event.args.deploymentId);
  const id = getIndexerDeploymentId(event.args.indexer, deploymentId);
  const timestamp = biToDate(event.block.timestamp);
  const status = event.args.status as unknown as ServiceStatus;

  let indexerDeployment = await IndexerDeployment.get(id);
  if (!indexerDeployment) {
    indexerDeployment = IndexerDeployment.create({
      id: getIndexerDeploymentId(event.args.indexer, deploymentId),
      indexerId: event.args.indexer,
      deploymentId: deploymentId,
      status,
      createdBlock: event.blockNumber,
      timestamp,
    });
    await indexerDeployment.save();
    return;
  }

  indexerDeployment.status = status;
  indexerDeployment.timestamp = timestamp;
  indexerDeployment.lastEvent = `handleIndexingReady:${event.blockNumber}`;

  await indexerDeployment.save();
}
