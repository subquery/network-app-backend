// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  ClosedAgreementCreatedEvent,
  UserAddedEvent,
  UserRemovedEvent,
} from '@subql/contract-sdk/typechain/ServiceAgreementRegistry';
import { Consumer, ServiceAgreement, User } from '../types';
import { biToDate, bytesToIpfsCid, SA_REGISTRY_ADDRESS } from './utils';
import { IServiceAgreementRegistry__factory } from '@subql/contract-sdk';
import { EthereumLog } from '@subql/types-ethereum';

export async function handleServiceAgreementCreated(
  event: EthereumLog<ClosedAgreementCreatedEvent['args']>
): Promise<void> {
  logger.info('handleClosedServiceAgreementCreated');
  assert(event.args, 'No event args');

  const { indexer, consumer, deploymentId, serviceAgreementId } = event.args;

  const agreementRegistry = IServiceAgreementRegistry__factory.connect(
    SA_REGISTRY_ADDRESS,
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
}

export async function handleUserAdded(
  event: EthereumLog<UserAddedEvent['args']>
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
  event: EthereumLog<UserRemovedEvent['args']>
): Promise<void> {
  logger.info('handleUserAdded');
  assert(event.args, 'No event args');

  const { user: userAddress } = event.args;
  await User.remove(userAddress);
}
