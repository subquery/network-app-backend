// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import {
  RegisterIndexerEvent,
  RemoveControllerAccountEvent,
  SetControllerAccountEvent,
  UnregisterIndexerEvent,
  UpdateMetadataEvent,
} from '@subql/contract-sdk/typechain/IndexerRegistry';
import assert from 'assert';
import { Indexer } from '../types';
import { bytesToIpfsCid } from './utils';

/* Indexer Registry Handlers */
export async function handleRegisterIndexer(
  event: AcalaEvmEvent<RegisterIndexerEvent['args']>
): Promise<void> {
  logger.info('handleRegisterIndexer');
  assert(event.args, 'No event args');
  const { indexer: indexerAddress, metadata } = event.args;

  const indexer = await Indexer.get(indexerAddress);

  if (indexer) {
    indexer.metadata = bytesToIpfsCid(metadata);
    indexer.active = true;
    indexer.lastEvent = `handleRegisterIndexer:${event.blockNumber}`;
    await indexer.save();
  }

  /* WARNING, other events are emitted before this handler (AddDelegation, SetCommissionRate),
   * their handlers are used to set their relevant values.
   */
}

export async function handleUnregisterIndexer(
  event: AcalaEvmEvent<UnregisterIndexerEvent['args']>
): Promise<void> {
  logger.info('handleUnregisterIndexer');
  assert(event.args, 'No event args');

  const indexer = await Indexer.get(event.args.indexer);
  assert(indexer, `Expected indexer to exist: ${event.args.indexer}`);

  indexer.active = false;
  indexer.lastEvent = `handleUnregisterIndexer:${event.blockNumber}`;
  await indexer.save();
}

export async function handleUpdateIndexerMetadata(
  event: AcalaEvmEvent<UpdateMetadataEvent['args']>
): Promise<void> {
  logger.info('handleUpdateIndexerMetadata');
  assert(event.args, 'No event args');
  const address = event.args.indexer;

  const indexer = await Indexer.get(address);
  assert(indexer, `Expected indexer (${address}) to exist`);

  indexer.metadata = bytesToIpfsCid(event.args.metadata);
  indexer.lastEvent = `handleUpdateIndexerMetadata:${event.blockNumber}`;
  await indexer.save();
}

export async function handleSetControllerAccount(
  event: AcalaEvmEvent<SetControllerAccountEvent['args']>
): Promise<void> {
  logger.info('handleSetControllerAccount');
  assert(event.args, 'No event args');
  const address = event.args.indexer;

  const indexer = await Indexer.get(address);
  assert(indexer, `Expected indexer (${address}) to exist`);

  indexer.controller = event.args.controller;
  indexer.lastEvent = `handleSetControllerAccount:${event.blockNumber}`;

  await indexer.save();
}

export async function handleRemoveControllerAccount(
  event: AcalaEvmEvent<RemoveControllerAccountEvent['args']>
): Promise<void> {
  logger.info('handleRemoveControllerAccount');
  assert(event.args, 'No event args');
  const address = event.args.indexer;

  const indexer = await Indexer.get(address);
  assert(indexer, `Expected indexer (${address}) to exist`);

  delete indexer.controller;
  indexer.lastEvent = `handleRemoveControllerAccount:${event.blockNumber}`;

  await indexer.save();
}
