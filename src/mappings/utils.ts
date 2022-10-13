// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import bs58 from 'bs58';
import { BigNumber } from '@ethersproject/bignumber';
import { EraManager } from '@subql/contract-sdk';
import deploymentFile from '@subql/contract-sdk/publish/moonbase.json';

import {
  Delegator,
  Indexer,
  EraValue,
  JSONBigInt,
  Exception,
  TotalLock,
} from '../types';
import { CreateIndexerParams } from '../interfaces';
import assert from 'assert';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';

export const QUERY_REGISTRY_ADDRESS = deploymentFile.QueryRegistry.address;
export const ERA_MANAGER_ADDRESS = deploymentFile.EraManager.address;
export const PLAN_MANAGER_ADDRESS = deploymentFile.PlanManager.address;
export const SA_REGISTRY_ADDRESS =
  deploymentFile.ServiceAgreementRegistry.address;
export const REWARD_DIST_ADDRESS = deploymentFile.RewardsDistributer.address;

declare global {
  interface BigIntConstructor {
    fromJSONType(value: unknown): bigint;
  }
  interface BigInt {
    toJSON(): string;
    toJSONType(): JSONBigInt;
    fromJSONType(value: unknown): bigint;
  }
}

BigInt.prototype.toJSON = function (): string {
  return BigNumber.from(this).toHexString();
};

BigInt.prototype.toJSONType = function () {
  return {
    type: 'bigint',
    value: this.toJSON(),
  };
};

BigInt.fromJSONType = function (value: JSONBigInt): bigint {
  if (value?.type !== 'bigint' && !value.value) {
    throw new Error('Value is not JSOBigInt');
  }

  return BigNumber.from(value.value).toBigInt();
};

export function bytesToIpfsCid(raw: string): string {
  // Add our default ipfs values for first 2 bytes:
  // function:0x12=sha2, size:0x20=256 bits
  // and cut off leading "0x"
  const hashHex = '1220' + raw.slice(2);
  const hashBytes = Buffer.from(hashHex, 'hex');
  return bs58.encode(hashBytes);
}

export function cidToBytes32(cid: string): string {
  return '0x' + Buffer.from(bs58.decode(cid)).slice(2).toString('hex');
}

export function bnToDate(bn: BigNumber): Date {
  return new Date(bn.toNumber() * 1000);
}

export function generatePlanId(indexer: string, idx: BigNumber): string {
  return `${indexer}:${idx.toHexString()}`;
}

export const operations: Record<string, (a: bigint, b: bigint) => bigint> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  replace: (a, b) => b,
};

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
    active,
    controller,
    createdBlock,
    lastEvent,
  });

  await indexer.save();
  return indexer;
}

export async function reportIndexerNonExistException(
  handler: string,
  indexerAddress: string,
  event: FrontierEvmEvent<any>
): Promise<void> {
  logger.error(`${handler}: Expected indexer to exist: ${indexerAddress}`);

  return reportException(
    handler,
    `Expected indexer to exist: ${indexerAddress}`,
    event
  );
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

export async function reportException(
  handler: string,
  error: string,
  event: FrontierEvmEvent<any>
): Promise<void> {
  const id = `${event.blockNumber}:${event.transactionHash}`;

  const exception = Exception.create({
    id,
    error: error || `Error: ${id}`,
    handler,
  });

  await exception.save();

  assert(false, `${id}: Error at ${handler}: ${error});`);
}
