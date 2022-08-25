// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import { ClosedAgreementCreatedEvent } from '@subql/contract-sdk/typechain/ServiceAgreementRegistry';
import { ServiceAgreement } from '../types';
import { bytesToIpfsCid, SA_REGISTRY_ADDRESS } from './utils';
import { IServiceAgreementRegistry__factory } from '@subql/contract-sdk';
import FrontierEthProvider from './ethProvider';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';

export async function handleServiceAgreementCreated(
  event: FrontierEvmEvent<ClosedAgreementCreatedEvent['args']>
): Promise<void> {
  logger.info('handleClosedServiceAgreementCreated');
  assert(event.args, 'No event args');

  const { indexer, consumer, deploymentId, serviceAgreementId } = event.args;

  const agreementRegistry = IServiceAgreementRegistry__factory.connect(
    SA_REGISTRY_ADDRESS,
    new FrontierEthProvider()
  );

  const agreement = await agreementRegistry.getClosedServiceAgreement(
    serviceAgreementId
  );
  const { period, lockedAmount, planTemplateId } = agreement;

  const endTime = new Date(event.blockTimestamp);
  endTime.setSeconds(endTime.getSeconds() + period.toNumber());

  const sa = ServiceAgreement.create({
    id: serviceAgreementId.toString(),
    indexerAddress: indexer,
    consumerAddress: consumer,
    deploymentId: bytesToIpfsCid(deploymentId),
    planTemplateId: planTemplateId.toHexString(),
    period: period.toBigInt(),
    startTime: event.blockTimestamp,
    endTime,
    lockedAmount: lockedAmount.toBigInt(),
    createdBlock: event.blockNumber,
  });

  await sa.save();
}
