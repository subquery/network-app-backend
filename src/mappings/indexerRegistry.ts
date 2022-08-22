// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { FrontierEvmEvent } from '@subql/frontier-evm-processor';
import {
  RegisterIndexerEvent,
  RemoveControllerAccountEvent,
  SetControllerAccountEvent,
  UnregisterIndexerEvent,
  UpdateMetadataEvent,
} from '@subql/contract-sdk/typechain/IndexerRegistry';
import assert from 'assert';
import { Indexer } from '../types';
import {
  bytesToIpfsCid,
  createIndexer,
  reportException,
  reportIndexerNonExistException,
} from './utils';

/* Indexer Registry Handlers */
export async function handleRegisterIndexer(
  event: FrontierEvmEvent<RegisterIndexerEvent['args']>
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
  } else {
    await createIndexer({
      address: indexerAddress,
      metadata: metadata,
      createdBlock: event.blockNumber,
      lastEvent: `handleRegisterIndexer:${event.blockNumber}`,
    });
  }

  /* WARNING, other events are emitted before this handler (AddDelegation, SetCommissionRate),
   * their handlers are used to set their relevant values.
   */
}

export async function handleUnregisterIndexer(
  event: FrontierEvmEvent<UnregisterIndexerEvent['args']>
): Promise<void> {
  logger.info('handleUnregisterIndexer');
  assert(event.args, 'No event args');

  const indexer = await Indexer.get(event.args.indexer);
  const lastEvent = `handleUnregisterIndexer:${event.blockNumber}`;

  if (indexer) {
    indexer.active = false;
    indexer.lastEvent = lastEvent;
    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'HandleUnregisterIndexer',
      event.args.indexer,
      event
    );
  }
}

export async function handleUpdateIndexerMetadata(
  event: FrontierEvmEvent<UpdateMetadataEvent['args']>
): Promise<void> {
  logger.info('handleUpdateIndexerMetadata');
  assert(event.args, 'No event args');
  const address = event.args.indexer;

  const indexer = await Indexer.get(address);
  const lastEvent = `handleUpdateIndexerMetadata: ${event.blockNumber}`;

  if (indexer) {
    indexer.metadata = bytesToIpfsCid(event.args.metadata);
    indexer.lastEvent = lastEvent;
    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'HandleUpdateIndexerMetadata',
      event.args.indexer,
      event
    );
  }
}

export async function handleSetControllerAccount(
  event: FrontierEvmEvent<SetControllerAccountEvent['args']>
): Promise<void> {
  logger.info('handleSetControllerAccount');
  assert(event.args, 'No event args');
  const address = event.args.indexer;

  const indexer = await Indexer.get(address);
  const lastEvent = `handleSetControllerAccount:${event.blockNumber}`;

  if (indexer) {
    indexer.controller = event.args.controller;
    indexer.lastEvent = lastEvent;
    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'HandleSetControllerAccount',
      event.args.indexer,
      event
    );
  }
}

export async function handleRemoveControllerAccount(
  event: FrontierEvmEvent<RemoveControllerAccountEvent['args']>
): Promise<void> {
  logger.info('handleRemoveControllerAccount');
  assert(event.args, 'No event args');
  const address = event.args.indexer;

  const indexer = await Indexer.get(address);
  const lastEvent = `handleRemoveControllerAccount:${event.blockNumber}`;

  if (indexer) {
    delete indexer.controller;
    indexer.lastEvent = lastEvent;

    await indexer.save();
  } else {
    await reportException(
      'HandleRemoveControllerAccount',
      event.args.indexer,
      event
    );
  }
}
