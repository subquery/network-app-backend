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
    selfStake: {
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
    if (selfStake) {
      indexer.selfStake = await upsertEraValue(
        indexer.selfStake,
        amount,
        operation,
        applyInstantly
      );
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
    delegator = Delegator.create({
      id: delegatorAddress,
      totalDelegations: await upsertEraValue(
        undefined,
        amount,
        operation,
        applyInstantly
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

  if (!totalLock) {
    totalLock = TotalLock.create({
      id: totalLockID,
      totalStake: await upsertEraValue(
        undefined,
        updatedStakeAmount.toBigInt(),
        operation
      ),
      totalDelegation: await upsertEraValue(
        undefined,
        updatedDelegateAmount.toBigInt(),
        operation
      ),
      createdBlock: event.blockNumber,
    });
  } else {
    totalLock.totalStake = await upsertEraValue(
      totalLock.totalStake,
      updatedStakeAmount.toBigInt(),
      operation
    );
    totalLock.totalDelegation = await upsertEraValue(
      totalLock.totalDelegation,
      updatedDelegateAmount.toBigInt(),
      operation
    );
    totalLock.lastEvent = `updateTotalLock - ${event.transactionHash}`;
  }

  await totalLock.save();
}
