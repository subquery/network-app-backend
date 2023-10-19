// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { IServiceAgreementRegistry__factory } from '@subql/contract-sdk';
import {
  ClosedAgreementCreatedEvent,
  TransferEvent,
} from '@subql/contract-sdk/typechain/ServiceAgreementRegistry';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { Deployment, Project, ServiceAgreement } from '../types';
import {
  Contracts,
  biToDate,
  bytesToIpfsCid,
  getContractAddress,
} from './utils';

export async function handleServiceAgreementCreated(
  event: EthereumLog<ClosedAgreementCreatedEvent['args']>
): Promise<void> {
  logger.info('handleClosedServiceAgreementCreated');
  assert(event.args, 'No event args');

  const { indexer, consumer, deploymentId, serviceAgreementId } = event.args;

  const network = await api.getNetwork();
  const agreementRegistry = IServiceAgreementRegistry__factory.connect(
    getContractAddress(network.chainId, Contracts.SA_REGISTRY_ADDRESS),
    api
  );

  const agreement = await agreementRegistry.getClosedServiceAgreement(
    serviceAgreementId
  );

  const { period, lockedAmount, planTemplateId } = agreement;
  const endTime = biToDate(event.block.timestamp);
  endTime.setSeconds(endTime.getSeconds() + period.toNumber());

  const sa = ServiceAgreement.create({
    id: serviceAgreementId.toString(),
    indexerAddress: indexer,
    consumerAddress: consumer,
    deploymentId: bytesToIpfsCid(deploymentId),
    planTemplateId: planTemplateId.toHexString(),
    period: period.toBigInt(),
    startTime: biToDate(event.block.timestamp),
    endTime,
    lockedAmount: lockedAmount.toBigInt(),
    createdBlock: event.blockNumber,
  });

  await sa.save();

  const deployment = await Deployment.get(sa.deploymentId);
  assert(deployment, `deployment ${sa.deploymentId} not found`);
  const project = await Project.get(deployment.projectId);
  assert(project, `project ${deployment.projectId} not found`);
  project.totalReward += lockedAmount.toBigInt();
  await project.save();
}

export async function handlerAgreementTransferred(
  event: EthereumLog<TransferEvent['args']>
): Promise<void> {
  logger.info('handlerAgreementTransferred');
  assert(event.args, 'No event args');

  const { from, to, tokenId } = event.args;

  const agreement = await ServiceAgreement.get(tokenId.toString());
  assert(agreement, `Expected query (${tokenId}) to exist`);
  assert(agreement.consumerAddress === from, `Expected owner to be ${from}`);

  agreement.consumerAddress = to;
  agreement.lastEvent = `handlerAgreementTransferred:${event.blockNumber}`;

  await agreement.save();
}
