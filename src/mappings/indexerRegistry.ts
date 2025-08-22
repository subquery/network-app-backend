// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  RegisterIndexerEvent,
  SetCommissionRateEvent,
  SetControllerAccountEvent,
  UnregisterIndexerEvent,
  UpdateMetadataEvent,
} from '@subql/contract-sdk/typechain/contracts/IndexerRegistry';
import assert from 'assert';
import { Controller, Indexer, IndexerCommissionRate } from '../types';
import {
  bytesToIpfsCid,
  Contracts,
  createIndexer,
  getContractAddress,
  reportIndexerNonExistException,
  updateFlattenedEraValue,
  upsertControllerAccount,
  upsertEraValue,
} from './utils';
import { IndexerRegistry__factory } from '@subql/contract-sdk';
import { EthereumLog } from '@subql/types-ethereum';
import { BigNumber } from 'ethers';
import { SetminimumStakingAmountTransaction } from '../types/abi-interfaces/IndexerRegistry';
import { cacheGetBigNumber, CacheKey, cacheSet } from './utils/cache';

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
      event,
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
    const prevController = await Controller.get(
      `${indexerAddress}:${indexer.controller}`
    );
    if (prevController) {
      prevController.isActive = false;
      await prevController.save();
    }

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

export async function handleSetCommissionRate(
  event: EthereumLog<SetCommissionRateEvent['args']>
): Promise<void> {
  logger.info('handleSetCommissionRate');
  assert(event.args, 'No event args');

  const address = event.args.indexer;

  const lastEvent = `handleSetCommissionRate:${event.blockNumber}`;
  let indexer = await Indexer.get(address);

  if (!indexer) {
    indexer = await createIndexer({
      address,
      lastEvent,
      createdBlock: event.blockNumber,
      event,
    });
  }

  indexer.commission = await upsertEraValue(
    indexer.commission,
    event.args.amount.toBigInt(),
    'replace',
    // Apply instantly when era is -1, this is an indication that indexer has just registered
    indexer.commission.era === -1
  );
  // Update flattened fields for commission
  updateFlattenedEraValue(indexer, 'commission', indexer.commission);

  indexer.lastEvent = `handleSetCommissionRate:${event.blockNumber}`;

  await indexer.save();

  await updateIndexerCommissionRate(
    indexer.id,
    indexer.commission.era,
    Number(BigInt.fromJSONType(indexer.commission.value)),
    Number(BigInt.fromJSONType(indexer.commission.valueAfter))
  );
}

async function updateIndexerCommissionRate(
  indexerId: string,
  eraIdx: number,
  commissionRate: number,
  nextCommissionRate: number
): Promise<void> {
  const currentEraId = `${indexerId}:${BigNumber.from(eraIdx).toHexString()}`;
  const next1EraId = `${indexerId}:${BigNumber.from(eraIdx + 1).toHexString()}`;
  const next2EraId = `${indexerId}:${BigNumber.from(eraIdx + 2).toHexString()}`;
  await IndexerCommissionRate.create({
    id: currentEraId,
    indexerId,
    eraId: BigNumber.from(eraIdx).toHexString(),
    eraIdx: eraIdx,
    commissionRate,
  }).save();
  await IndexerCommissionRate.create({
    id: next1EraId,
    indexerId,
    eraId: BigNumber.from(eraIdx + 1).toHexString(),
    eraIdx: eraIdx + 1,
    commissionRate,
  }).save();
  await IndexerCommissionRate.create({
    id: next2EraId,
    indexerId,
    eraId: BigNumber.from(eraIdx + 2).toHexString(),
    eraIdx: eraIdx + 2,
    commissionRate: nextCommissionRate,
  }).save();
}

export async function getMinimumStakingAmount(): Promise<BigNumber> {
  let minimumStakingAmount = await cacheGetBigNumber(
    CacheKey.MinimumStakingAmount
  );
  if (minimumStakingAmount === undefined) {
    const network = await api.getNetwork();
    const indexerRegistry = IndexerRegistry__factory.connect(
      getContractAddress(network.chainId, Contracts.INDEXER_REGISTRY_ADDRESS),
      api
    );

    minimumStakingAmount = await indexerRegistry.minimumStakingAmount();
    await cacheSet(
      CacheKey.MinimumStakingAmount,
      minimumStakingAmount.toString()
    );
  }
  return minimumStakingAmount;
}

export async function handleSetMinimumStakingAmount(
  tx: SetminimumStakingAmountTransaction
): Promise<void> {
  const receipt = await tx.receipt();
  if (receipt.status) {
    const amount = tx.args?.[0] as BigNumber;
    await cacheSet(CacheKey.MinimumStakingAmount, amount.toString());
  }
}
