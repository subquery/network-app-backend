// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  RegisterIndexerEvent,
  RemoveControllerAccountEvent,
  SetCommissionRateEvent,
  SetControllerAccountEvent,
  UnregisterIndexerEvent,
  UpdateMetadataEvent,
} from '@subql/contract-sdk/typechain/IndexerRegistry';
import assert from 'assert';
import { Controller, Indexer } from '../types';
import {
  bytesToIpfsCid,
  Contracts,
  createIndexer,
  getContractAddress,
  reportException,
  reportIndexerNonExistException,
  upsertControllerAccount,
  upsertEraValue,
} from './utils';
import {
  EraManager__factory,
  IndexerRegistry__factory,
} from '@subql/contract-sdk';
import { EthereumLog } from '@subql/types-ethereum';

/* Indexer Registry Handlers */
export async function handleRegisterIndexer(
  event: EthereumLog<RegisterIndexerEvent['args']>
): Promise<void> {
  logger.info('handleRegisterIndexer');
  assert(event.args, 'No event args');
  const { indexer: indexerAddress, metadata } = event.args;

  const indexer = await Indexer.get(indexerAddress);
  const cid = bytesToIpfsCid(metadata);

  if (indexer) {
    indexer.metadata = cid;
    indexer.active = true;
    indexer.lastEvent = `handleRegisterIndexer:${event.blockNumber}`;
    await indexer.save();
  } else {
    await createIndexer({
      address: indexerAddress,
      metadata: cid,
      createdBlock: event.blockNumber,
      lastEvent: `handleRegisterIndexer:${event.blockNumber}`,
    });
  }

  /* WARNING, other events are emitted before this handler (AddDelegation, SetCommissionRate),
   * their handlers are used to set their relevant values.
   */
}

export async function handleUnregisterIndexer(
  event: EthereumLog<UnregisterIndexerEvent['args']>
): Promise<void> {
  logger.info('handleUnregisterIndexer');
  assert(event.args, 'No event args');

  const indexer = await Indexer.get(event.args.indexer);
  const lastEvent = `handleUnregisterIndexer:${event.blockNumber}`;

  const network = await api.getNetwork();
  const IndexerRegistry = IndexerRegistry__factory.connect(
    getContractAddress(network.chainId, Contracts.INDEXER_REGISTRY_ADDRESS),
    api
  );
  const controllerAddress = await IndexerRegistry.getController(
    event.args.indexer
  );

  if (indexer) {
    indexer.active = false;
    indexer.lastEvent = lastEvent;
    delete indexer.controller;
    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'HandleUnregisterIndexer',
      event.args.indexer,
      event
    );
  }

  const controller = await Controller.get(
    `${event.args.indexer}:${controllerAddress}`
  );

  if (controller) {
    controller.lastEvent = lastEvent;
    controller.isActive = false;
    await controller.save();
  }
}

export async function handleUpdateIndexerMetadata(
  event: EthereumLog<UpdateMetadataEvent['args']>
): Promise<void> {
  logger.info('handleUpdateIndexerMetadata');
  assert(event.args, 'No event args');
  const { indexer: address, metadata } = event.args;

  const indexer = await Indexer.get(address);
  const lastEvent = `handleUpdateIndexerMetadata: ${event.blockNumber}`;

  if (indexer) {
    indexer.lastEvent = lastEvent;
    indexer.metadata = bytesToIpfsCid(metadata);
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
  event: EthereumLog<SetControllerAccountEvent['args']>
): Promise<void> {
  logger.info('handleSetControllerAccount');
  assert(event.args, 'No event args');
  const { indexer: indexerAddress, controller: controllerAddress } = event.args;

  const indexer = await Indexer.get(indexerAddress);
  const lastEvent = `handleSetControllerAccount:${event.blockNumber}`;

  if (indexer) {
    indexer.controller = event.args.controller;
    indexer.lastEvent = lastEvent;
    await indexer.save();
    await upsertControllerAccount(
      indexerAddress,
      controllerAddress,
      event,
      lastEvent
    );
  } else {
    await reportIndexerNonExistException(
      'handleSetControllerAccount',
      event.args.indexer,
      event
    );
  }
}

export async function handleRemoveControllerAccount(
  event: EthereumLog<RemoveControllerAccountEvent['args']>
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

  const controller = await Controller.get(
    `${event.args.indexer}:${event.args.controller}`
  );

  if (controller) {
    controller.lastEvent = lastEvent;
    controller.isActive = false;
    await controller.save();
  }
}

export async function handleSetCommissionRate(
  event: EthereumLog<SetCommissionRateEvent['args']>
): Promise<void> {
  logger.info('handleSetCommissionRate');
  assert(event.args, 'No event args');

  const address = event.args.indexer;
  const network = await api.getNetwork();
  const eraManager = EraManager__factory.connect(
    getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
    api
  );

  const lastEvent = `handleSetCommissionRate:${event.blockNumber}`;
  let indexer = await Indexer.get(address);

  if (!indexer) {
    indexer = await createIndexer({
      address,
      lastEvent,
      createdBlock: event.blockNumber,
    });
  }

  indexer.commission = await upsertEraValue(
    eraManager,
    indexer.commission,
    event.args.amount.toBigInt(),
    'replace',
    // Apply instantly when era is -1, this is an indication that indexer has just registered
    indexer.commission.era === -1
  );
  indexer.lastEvent = `handleSetCommissionRate:${event.blockNumber}`;

  await indexer.save();
}
