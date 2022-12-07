// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  ClosedAgreementCreatedEvent,
  UserAddedEvent,
  UserRemovedEvent,
} from '@subql/contract-sdk/typechain/ServiceAgreementRegistry';
import { Consumer, ServiceAgreement, User } from '../types';
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

export async function handleUserAdded(
  event: FrontierEvmEvent<UserAddedEvent['args']>
): Promise<void> {
  logger.info('handleUserAdded');
  assert(event.args, 'No event args');

  const { consumer: consumerAddress, user: userAddress } = event.args;
  const lastEvent = `handleUserAdded: ${event.blockNumber}`;

  let consumer = await Consumer.get(consumerAddress);

  if (!consumer) {
    consumer = Consumer.create({
      id: consumerAddress,
      createdBlock: event.blockNumber,
      lastEvent,
    });
  } else {
    consumer.lastEvent = lastEvent;
  }

  await consumer.save();

  let user = await User.get(userAddress);

  if (!user) {
    user = User.create({
      id: userAddress,
      consumerId: consumerAddress,
      createdBlock: event.blockNumber,
      lastEvent,
    });
  } else {
    user.consumerId = consumerAddress;
    user.lastEvent = lastEvent;
  }

  await user.save();
}

export async function handleUserRemoved(
  event: FrontierEvmEvent<UserRemovedEvent['args']>
): Promise<void> {
  logger.info('handleUserAdded');
  assert(event.args, 'No event args');

  const { user: userAddress } = event.args;
  await User.remove(userAddress);
}
