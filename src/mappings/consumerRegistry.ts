// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ControllerAddedLog,
  ControllerRemovedLog,
} from '../types/abi-interfaces/ConsumerRegistry';
import assert from 'assert';
import { Consumer, ConsumerController } from '../types';

export async function handleConsumerControllerAdded(
  event: ControllerAddedLog
): Promise<void> {
  assert(event.args, 'No event args');
  const { consumer, controller } = event.args;
  logger.info(`handleConsumerControllerAdded: ${consumer} ${controller}`);
  let consumerEntity = await Consumer.get(consumer);
  const lastEvent = `handleConsumerControllerAdded: ${event.blockNumber}`;
  if (!consumerEntity) {
    consumerEntity = Consumer.create({
      id: consumer,
      createdBlock: event.blockNumber,
      lastEvent,
    });
  } else {
    consumerEntity.lastEvent = lastEvent;
  }
  await consumerEntity.save();
  await ConsumerController.create({
    id: `${consumer}_${controller}`,
    consumerId: consumer,
    address: controller,

    createdBlock: event.blockNumber,
    lastEvent,
  }).save();
}

export async function handleConsumerControllerRemoved(
  event: ControllerRemovedLog
): Promise<void> {
  assert(event.args, 'No event args');
  const { consumer, controller } = event.args;
  logger.info(`handleConsumerControllerRemoved: ${consumer} ${controller}`);
  await ConsumerController.remove(`${consumer}_${controller}`);
}
