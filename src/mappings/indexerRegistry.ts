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
import { CreateIndexerProps } from '../customTypes';
import { Indexer } from '../types';
import { bytesToIpfsCid, reportException } from './utils';

async function createIndexer({
  address,
  metadata = '',
  active = true,
  createdBlock,
  lastEvent,
  controller,
}: CreateIndexerProps) {
  const indexer = Indexer.create({
    id: address,
    metadata: metadata,
    totalStake: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    commission: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    active: active,
    controller,
    createdBlock,
    lastEvent,
  });

  await indexer.save();
}

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
  const lastEvent = `handleUnregisterIndexer:${event.blockNumber}`;

  if (indexer) {
    indexer.active = false;
    indexer.lastEvent = lastEvent;
    await indexer.save();
  } else {
    logger.error(
      `HandleUnregisterIndexer: Expected indexer to exist: ${event.args.indexer}`
    );
    await createIndexer({
      address: event.args.indexer,
      active: false,
      lastEvent,
      createdBlock: event.blockNumber,
    });

    await reportException(
      'HandleUnregisterIndexer',
      event.logIndex,
      event.blockNumber,
      `Expected indexer to exist: ${event.args.indexer}`
    );
  }
}

export async function handleUpdateIndexerMetadata(
  event: AcalaEvmEvent<UpdateMetadataEvent['args']>
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
    logger.error(
      `HandleUpdateIndexerMetadata: Expected indexer to exist: ${event.args.indexer}`
    );
    await createIndexer({
      address: event.args.indexer,
      metadata: bytesToIpfsCid(event.args.metadata),
      lastEvent,
      createdBlock: event.blockNumber,
    });

    await reportException(
      'HandleUpdateIndexerMetadata',
      event.logIndex,
      event.blockNumber,
      `Expected indexer to exist: ${event.args.indexer}`
    );
  }
}

export async function handleSetControllerAccount(
  event: AcalaEvmEvent<SetControllerAccountEvent['args']>
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
    logger.error(
      `HandleSetControllerAccount: Expected indexer to exist: ${event.args.indexer}`
    );
    await createIndexer({
      address: event.args.indexer,
      controller: event.args.controller,
      lastEvent,
      createdBlock: event.blockNumber,
    });

    await reportException(
      'HandleSetControllerAccount',
      event.logIndex,
      event.blockNumber,
      `Expected indexer to exist: ${event.args.indexer}`
    );
  }
}

export async function handleRemoveControllerAccount(
  event: AcalaEvmEvent<RemoveControllerAccountEvent['args']>
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
    logger.error(
      `HandleRemoveControllerAccount: Expected indexer to exist: ${event.args.indexer}`
    );
    await createIndexer({
      address: event.args.indexer,
      lastEvent,
      createdBlock: event.blockNumber,
    });

    await reportException(
      'HandleRemoveControllerAccount',
      event.logIndex,
      event.blockNumber,
      `Expected indexer to exist: ${event.args.indexer}`
    );
  }
}
