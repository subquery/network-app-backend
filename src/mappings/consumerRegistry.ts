// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ControllerAddedLog,
  ControllerRemovedLog,
} from '../types/abi-interfaces/ConsumerRegistry';
import assert from 'assert';
import { ConsumerController } from '../types';

export async function handleConsumerControllerAdded(
  event: ControllerAddedLog
): Promise<void> {
  assert(event.args, 'No event args');
  const { consumer, controller } = event.args;
  logger.info(`handleConsumerControllerAdded: ${consumer} ${controller}`);
  await ConsumerController.create({
    id: `${consumer}_${controller}`,
    consumer: consumer,
    controller: controller,

    createdBlock: event.blockNumber,
    lastEvent: `handleConsumerControllerAdded: ${event.blockNumber}`,
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
