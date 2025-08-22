// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { Staking__factory } from '@subql/contract-sdk';
import { EthereumLog } from '@subql/types-ethereum';
import { BigNumber } from 'ethers';
import { CreateIndexerParams } from '../../interfaces';
import {
  Indexer,
  EraValue,
  JSONBigInt,
  Delegation,
  Delegator,
  TotalLock,
  Controller,
  IndexerApySummary,
} from '../../types';
import {
  bigNumberFrom,
  bigNumbertoJSONType,
  biToDate,
  Contracts,
  getContractAddress,
  getDelegationId,
  min,
  operations,
  reportIndexerNonExistException,
} from './helpers';
import { getCurrentEra } from '../eraManager';
import { getMinimumStakingAmount } from '../indexerRegistry';
import { getIndexerLeverageLimit } from '../staking';

export async function createIndexer({
  address,
  metadata = '',
  active = true,
  createdBlock,
  lastEvent,
  controller,
  event,
}: CreateIndexerParams): Promise<Indexer> {
  const indexer = Indexer.create({
    id: address,
    metadata,
    capacity: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    capacityEra: -1,
    capacityEraValue: BigInt(0),
    capacityEraValueAfter: BigInt(0),
    selfStake: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    selfStakeEra: -1,
    selfStakeEraValue: BigInt(0),
    selfStakeEraValueAfter: BigInt(0),
    totalStake: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    totalStakeEra: -1,
    totalStakeEraValue: BigInt(0),
    totalStakeEraValueAfter: BigInt(0),
    maxUnstakeAmount: BigInt(0).toJSONType(),
    maxUnstakeAmountValue: BigInt(0),
    commission: {
      era: -1,
      value: BigInt(0).toJSONType(),
      valueAfter: BigInt(0).toJSONType(),
    },
    commissionEra: -1,
    commissionEraValue: BigInt(0),
    commissionEraValueAfter: BigInt(0),
    active,
    controller,
    createdBlock,
    lastEvent,
  });
  await indexer.save();

  await IndexerApySummary.create({
    id: address,
    eraIdx: -1,
    indexerId: address,
    indexerReward: BigInt(0),
    indexerApy: BigInt(0),
    delegatorReward: BigInt(0),
    delegatorApy: BigInt(0),
    createAt: biToDate(event.block.timestamp),
    updateAt: biToDate(event.block.timestamp),
  }).save();

  return indexer;
}

export async function upsertControllerAccount(
  indexerAddress: string,
  controllerAddress: string,
  event: EthereumLog,
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
      isActive: true,
    });
  } else {
    controller.indexerId = indexerAddress;
    controller.lastEvent = lastEvent;
    controller.isActive = true;
  }
  await controller.save();
}

export async function upsertEraValue(
  eraValue: EraValue | undefined,
  value: bigint,
  operation: keyof typeof operations = 'add',
  applyInstantly?: boolean
): Promise<EraValue> {
  const currentEra = await getCurrentEra();

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

// Helper function to update flattened EraValue fields
export function updateFlattenedEraValue(
  entity: any,
  fieldPrefix: string,
  eraValue: EraValue
): void {
  entity[`${fieldPrefix}Era`] = eraValue.era;
  entity[`${fieldPrefix}EraValue`] = BigInt.fromJSONType(eraValue.value);
  entity[`${fieldPrefix}EraValueAfter`] = BigInt.fromJSONType(
    eraValue.valueAfter
  );
}

// Helper function to update flattened JSONBigInt fields
export function updateFlattenedJSONBigInt(
  entity: any,
  fieldPrefix: string,
  jsonBigInt: JSONBigInt
): void {
  entity[`${fieldPrefix}Value`] = BigInt.fromJSONType(jsonBigInt);
}

// Helper function to update flattened array fields for DelegationFrom
export function updateFlattenedDelegationFrom(
  entity: any,
  delegations: any[]
): void {
  entity.delegatorAddresses = delegations.map((d) => d.delegator);
  entity.delegatorAmounts = delegations.map((d) => d.amount);
}

// Helper function to update flattened array fields for DelegationTo
export function updateFlattenedDelegationTo(
  entity: any,
  delegations: any[]
): void {
  entity.indexerAddresses = delegations.map((d) => d.indexer);
  entity.indexerAmounts = delegations.map((d) => d.amount);
}

export async function updateMaxUnstakeAmount(
  indexerAddress: string,
  event: EthereumLog
): Promise<void> {
  const leverageLimit = await getIndexerLeverageLimit();
  const minStakingAmount = await getMinimumStakingAmount();

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
      // Update flattened field
      updateFlattenedJSONBigInt(
        indexer,
        'maxUnstakeAmount',
        indexer.maxUnstakeAmount
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
      // Update flattened field
      updateFlattenedJSONBigInt(
        indexer,
        'maxUnstakeAmount',
        indexer.maxUnstakeAmount
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
  indexerAddress: string,
  amount: bigint,
  operation: keyof typeof operations,
  event: EthereumLog,
  selfStake: boolean,
  applyInstantly: boolean
): Promise<void> {
  const indexer = await Indexer.get(indexerAddress);

  if (indexer) {
    indexer.totalStake = await upsertEraValue(
      indexer.totalStake,
      amount,
      operation,
      applyInstantly
    );
    // Update flattened fields for totalStake
    updateFlattenedEraValue(indexer, 'totalStake', indexer.totalStake);

    if (selfStake) {
      indexer.selfStake = await upsertEraValue(
        indexer.selfStake,
        amount,
        operation,
        applyInstantly
      );
      // Update flattened fields for selfStake
      updateFlattenedEraValue(indexer, 'selfStake', indexer.selfStake);
    }

    await indexer.save();
    // await updateIndexerCapacity(indexerAddress, event);
  } else {
    await reportIndexerNonExistException(
      'updateTotalStake',
      indexerAddress,
      event
    );
  }
}

export async function updateDelegatorDelegation(
  delegatorAddress: string,
  amount: bigint,
  operation: keyof typeof operations = 'add',
  applyInstantly?: boolean
): Promise<void> {
  const currentEra = await getCurrentEra();
  let delegator = await Delegator.get(delegatorAddress);

  if (!delegator) {
    const totalDelegations = await upsertEraValue(
      undefined,
      amount,
      operation,
      applyInstantly
    );
    delegator = Delegator.create({
      id: delegatorAddress,
      totalDelegations,
      totalDelegationsEra: totalDelegations.era,
      totalDelegationsEraValue: BigInt.fromJSONType(totalDelegations.value),
      totalDelegationsEraValueAfter: BigInt.fromJSONType(
        totalDelegations.valueAfter
      ),
      startEra: applyInstantly ? currentEra : currentEra + 1,
      exitEra: -1,
    });
  } else {
    delegator.totalDelegations = await upsertEraValue(
      delegator.totalDelegations,
      amount,
      operation,
      applyInstantly
    );
    // Update flattened fields for existing delegator
    updateFlattenedEraValue(
      delegator,
      'totalDelegations',
      delegator.totalDelegations
    );
    if (BigNumber.from(delegator.totalDelegations.valueAfter.value).lte(0)) {
      delegator.exitEra = currentEra + 1;
    } else {
      const prevExitEra = delegator.exitEra;
      delegator.exitEra = -1;
      if (prevExitEra != -1 && currentEra >= prevExitEra) {
        delegator.startEra = applyInstantly ? currentEra : currentEra + 1;
      }
    }
  }

  await delegator.save();
}

export async function updateIndexerCapacity(
  address: string,
  event: EthereumLog
): Promise<void> {
  const indexer = await Indexer.get(address);
  const leverageLimit = await getIndexerLeverageLimit();

  if (indexer) {
    const indexerSelfStake = indexer.selfStake;
    const indexerTotalStake = indexer.totalStake;

    const currentEra = await getCurrentEra();

    const selfStakeCurr = bigNumberFrom(
      currentEra > indexerSelfStake.era
        ? indexerSelfStake.valueAfter.value
        : indexerSelfStake.value.value
    );
    const selfStakeAfter = bigNumberFrom(indexerSelfStake.valueAfter.value);

    const totalStakeCurr = bigNumberFrom(
      currentEra > indexerTotalStake.era
        ? indexerTotalStake.valueAfter.value
        : indexerTotalStake.value.value
    );
    const totalStakeAfter = bigNumberFrom(indexerTotalStake.valueAfter.value);

    const current = selfStakeCurr.mul(leverageLimit).sub(totalStakeCurr);
    const after = selfStakeAfter.mul(leverageLimit).sub(totalStakeAfter);

    indexer.capacity = {
      era: currentEra,
      value: current.toBigInt().toJSONType(),
      valueAfter: after.toBigInt().toJSONType(),
    };
    // Update flattened fields for capacity
    updateFlattenedEraValue(indexer, 'capacity', indexer.capacity);

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
  amount: bigint,
  operation: keyof typeof operations = 'add',
  isSelf: boolean,
  event: EthereumLog<any>
): Promise<void> {
  const totalLockID = 'TotalLock';
  let totalLock = await TotalLock.get(totalLockID);
  const updatedStakeAmount = isSelf
    ? BigNumber.from(amount)
    : BigNumber.from(0);
  const updatedDelegateAmount = isSelf
    ? BigNumber.from(0)
    : BigNumber.from(amount);

  const { instant } = event.args || {};

  if (!totalLock) {
    const totalStake = await upsertEraValue(
      undefined,
      updatedStakeAmount.toBigInt(),
      operation
    );
    const totalDelegation = await upsertEraValue(
      undefined,
      updatedDelegateAmount.toBigInt(),
      operation
    );
    totalLock = TotalLock.create({
      id: totalLockID,
      totalStake,
      totalStakeEra: totalStake.era,
      totalStakeEraValue: BigInt.fromJSONType(totalStake.value),
      totalStakeEraValueAfter: BigInt.fromJSONType(totalStake.valueAfter),
      totalDelegation,
      totalDelegationEra: totalDelegation.era,
      totalDelegationEraValue: BigInt.fromJSONType(totalDelegation.value),
      totalDelegationEraValueAfter: BigInt.fromJSONType(
        totalDelegation.valueAfter
      ),
      createdBlock: event.blockNumber,
    });
  } else {
    totalLock.totalStake = await upsertEraValue(
      totalLock.totalStake,
      updatedStakeAmount.toBigInt(),
      operation,
      instant
    );
    // Update flattened fields for totalStake
    updateFlattenedEraValue(totalLock, 'totalStake', totalLock.totalStake);

    totalLock.totalDelegation = await upsertEraValue(
      totalLock.totalDelegation,
      updatedDelegateAmount.toBigInt(),
      operation,
      instant
    );
    // Update flattened fields for totalDelegation
    updateFlattenedEraValue(
      totalLock,
      'totalDelegation',
      totalLock.totalDelegation
    );

    totalLock.lastEvent = `updateTotalLock - ${event.transactionHash}`;
  }

  await totalLock.save();
}
