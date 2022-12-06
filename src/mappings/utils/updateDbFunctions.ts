// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  EraManager,
  EraManager__factory,
  IndexerRegistry__factory,
  Staking__factory,
} from '@subql/contract-sdk';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';
import FrontierEthProvider from '../ethProvider';
import { BigNumber } from 'ethers';
import { CreateIndexerParams } from '../../interfaces';
import {
  IndexerMetadata,
  Indexer,
  EraValue,
  JSONBigInt,
  Delegation,
  Delegator,
  TotalLock,
  Controller,
} from '../../types';
import {
  bigNumberFrom,
  bigNumbertoJSONType,
  decodeMetadata,
  ERA_MANAGER_ADDRESS,
  getDelegationId,
  INDEXER_REGISTRY_ADDRESS,
  min,
  operations,
  reportIndexerNonExistException,
  STAKING_ADDRESS,
} from './helpers';

export async function createIndexer({
  address,
  metadata = '',
  active = true,
  createdBlock,
  lastEvent,
  controller,
}: CreateIndexerParams): Promise<Indexer> {
  const indexer = Indexer.create({
    id: address,
    metadataId: metadata ? address : undefined,
    capacity: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    totalStake: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    maxUnstakeAmount: BigInt(0).toJSONType(),
    commission: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    active,
    controller,
    createdBlock,
    lastEvent,
  });

  await indexer.save();
  return indexer;
}

export async function upsertIndexerMetadata(
  address: string,
  metadataCID: string
): Promise<void> {
  const metadataRes = await decodeMetadata(metadataCID);
  const { name, url } = metadataRes || {};

  let metadata = await IndexerMetadata.get(metadataCID);
  if (!metadata) {
    metadata = IndexerMetadata.create({
      id: address,
      metadataCID,
      name,
      url,
    });
  } else {
    metadata.metadataCID = metadataCID;
    metadata.name = name;
    metadata.url = url;
  }

  await metadata.save();
}

export async function upsertControllerAccount(
  indexerAddress: string,
  controllerAddress: string,
  event: FrontierEvmEvent,
  lastEvent: string
): Promise<void> {
  let controller = await Controller.get(controllerAddress);

  if (!controller) {
    controller = Controller.create({
      id: `${indexerAddress}:${controllerAddress}`,
      indexerId: indexerAddress,
      controller: controllerAddress,
      lastEvent,
      createdBlock: event.blockNumber,
    });
  } else {
    controller.createdBlock = event.blockNumber;
    controller.lastEvent = lastEvent;
  }
  await controller.save();
}

export async function upsertEraValue(
  eraManager: EraManager,
  eraValue: EraValue | undefined,
  value: bigint,
  operation: keyof typeof operations = 'add',
  applyInstantly?: boolean
): Promise<EraValue> {
  const currentEra = await eraManager.eraNumber().then((r) => r.toNumber());

  if (!eraValue) {
    return {
      era: currentEra,
      value: (applyInstantly ? value : BigInt(0)).toJSONType(),
      valueAfter: value.toJSONType(),
    };
  }

  const applyOperation = (existing: JSONBigInt) =>
    operations[operation](BigInt.fromJSONType(existing), value).toJSONType();

  const valueAfter = applyOperation(eraValue.valueAfter);

  if (eraValue.era === currentEra) {
    const newValue = applyInstantly
      ? applyOperation(eraValue.value)
      : eraValue.value;

    return {
      era: currentEra,
      value: newValue,
      valueAfter,
    };
  }

  const newValue = applyInstantly
    ? applyOperation(eraValue.valueAfter)
    : eraValue.valueAfter;

  return {
    era: currentEra,
    value: newValue,
    valueAfter,
  };
}

export async function updateMaxUnstakeAmount(
  indexerAddress: string,
  event: FrontierEvmEvent
): Promise<void> {
  const staking = Staking__factory.connect(
    STAKING_ADDRESS,
    new FrontierEthProvider()
  );
  const indexerRegistry = IndexerRegistry__factory.connect(
    INDEXER_REGISTRY_ADDRESS,
    new FrontierEthProvider()
  );

  const leverageLimit = await staking.indexerLeverageLimit();
  const minStakingAmount = await indexerRegistry.minimumStakingAmount();

  const indexer = await Indexer.get(indexerAddress);

  if (indexer) {
    const { totalStake } = indexer;

    const delegationId = getDelegationId(indexerAddress, indexerAddress);
    const { amount: ownStake } = (await Delegation.get(delegationId)) || {};

    const totalStakingAmountAfter = bigNumberFrom(totalStake.valueAfter.value);
    const ownStakeAfter = bigNumberFrom(ownStake?.valueAfter.value);

    if (leverageLimit.eq(1)) {
      indexer.maxUnstakeAmount = bigNumbertoJSONType(
        ownStakeAfter.sub(minStakingAmount)
      );
    } else {
      const maxUnstakeAmount = min(
        ownStakeAfter.sub(minStakingAmount),
        ownStakeAfter
          .mul(leverageLimit)
          .sub(totalStakingAmountAfter)
          .div(leverageLimit.sub(1))
      );

      indexer.maxUnstakeAmount = bigNumbertoJSONType(
        maxUnstakeAmount.isNegative() ? BigNumber.from(0) : maxUnstakeAmount
      );
    }

    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'updateMaxUnstakeAmount',
      indexerAddress,
      event
    );
  }
}

export async function updateTotalStake(
  eraManager: EraManager,
  indexerAddress: string,
  amount: bigint,
  operation: keyof typeof operations,
  event: FrontierEvmEvent,
  applyInstantly?: boolean
): Promise<void> {
  const indexer = await Indexer.get(indexerAddress);

  if (indexer) {
    indexer.totalStake = await upsertEraValue(
      eraManager,
      indexer.totalStake,
      amount,
      operation,
      applyInstantly
    );

    await indexer.save();
    await updateIndexerCapacity(indexerAddress, event);
  } else {
    await reportIndexerNonExistException(
      'updateTotalStake',
      indexerAddress,
      event
    );
  }
}

export async function updateTotalDelegation(
  eraManager: EraManager,
  delegatorAddress: string,
  amount: bigint,
  operation: keyof typeof operations = 'add',
  applyInstantly?: boolean
): Promise<void> {
  let delegator = await Delegator.get(delegatorAddress);

  if (!delegator) {
    delegator = Delegator.create({
      id: delegatorAddress,
      totalDelegations: await upsertEraValue(
        eraManager,
        undefined,
        amount,
        operation,
        applyInstantly
      ),
    });
  } else {
    delegator.totalDelegations = await upsertEraValue(
      eraManager,
      delegator.totalDelegations,
      amount,
      operation,
      applyInstantly
    );
  }

  await delegator.save();
}

export async function updateIndexerCapacity(
  address: string,
  event: FrontierEvmEvent
): Promise<void> {
  const indexer = await Indexer.get(address);
  const delegationId = getDelegationId(address, address);
  const delegation = await Delegation.get(delegationId);
  const staking = Staking__factory.connect(
    STAKING_ADDRESS,
    new FrontierEthProvider()
  );
  const eraManager = EraManager__factory.connect(
    ERA_MANAGER_ADDRESS,
    new FrontierEthProvider()
  );

  const leverageLimit = await staking.indexerLeverageLimit();

  if (indexer) {
    const indexerStake = delegation?.amount;
    const indexerTotalStake = indexer?.totalStake;

    const stakeCurr = bigNumberFrom(indexerStake?.value.value);
    const stakeAfter = bigNumberFrom(indexerStake?.valueAfter.value);

    const totalStakeCurr = bigNumberFrom(indexerTotalStake?.value.value);
    const totalStakeAfter = bigNumberFrom(indexerTotalStake?.valueAfter.value);

    const current = stakeCurr.mul(leverageLimit).sub(totalStakeCurr);
    const after = stakeAfter.mul(leverageLimit).sub(totalStakeAfter);

    const currentEra = await eraManager.eraNumber().then((r) => r.toNumber());

    indexer.capacity = {
      era: currentEra,
      value: current.toBigInt().toJSONType(),
      valueAfter: after.toBigInt().toJSONType(),
    };

    await indexer.save();
  } else {
    await reportIndexerNonExistException(
      'updateIndexerCapacity',
      address,
      event
    );
  }
}

export async function updateTotalLock(
  eraManager: EraManager,
  amount: bigint,
  operation: keyof typeof operations = 'add',
  isSelf: boolean,
  event: FrontierEvmEvent<any>
): Promise<void> {
  const totalLockID = 'TotalLock';
  let totalLock = await TotalLock.get(totalLockID);
  const updatedStakeAmount = isSelf
    ? BigNumber.from(amount)
    : BigNumber.from(0);
  const updatedDelegateAmount = isSelf
    ? BigNumber.from(0)
    : BigNumber.from(amount);

  if (!totalLock) {
    totalLock = TotalLock.create({
      id: totalLockID,
      totalStake: await upsertEraValue(
        eraManager,
        undefined,
        updatedStakeAmount.toBigInt(),
        operation
      ),
      totalDelegation: await upsertEraValue(
        eraManager,
        undefined,
        updatedDelegateAmount.toBigInt(),
        operation
      ),
      createdBlock: event.blockNumber,
    });
  } else {
    totalLock.totalStake = await upsertEraValue(
      eraManager,
      totalLock.totalStake,
      updatedStakeAmount.toBigInt(),
      operation
    );
    totalLock.totalDelegation = await upsertEraValue(
      eraManager,
      totalLock.totalDelegation,
      updatedDelegateAmount.toBigInt(),
      operation
    );
    totalLock.lastEvent = `updateTotalLock - ${event.transactionHash}`;
  }

  await totalLock.save();
}