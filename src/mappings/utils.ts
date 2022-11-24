// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import bs58 from 'bs58';
import { BigNumber } from '@ethersproject/bignumber';
import {
  EraManager,
  EraManager__factory,
  Staking__factory,
} from '@subql/contract-sdk';
import deploymentFile from '@subql/contract-sdk/publish/moonbase.json';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';
import FrontierEthProvider from './ethProvider';
import fetch from 'node-fetch';

import {
  Delegator,
  Indexer,
  IndexerMetadata,
  EraValue,
  JSONBigInt,
  Exception,
  TotalLock,
  Delegation,
} from '../types';
import { CreateIndexerParams } from '../interfaces';
import assert from 'assert';

export const QUERY_REGISTRY_ADDRESS = deploymentFile.QueryRegistry.address;
export const ERA_MANAGER_ADDRESS = deploymentFile.EraManager.address;
export const STAKING_ADDRESS = deploymentFile.Staking.address;
export const PLAN_MANAGER_ADDRESS = deploymentFile.PlanManager.address;
export const SA_REGISTRY_ADDRESS =
  deploymentFile.ServiceAgreementRegistry.address;
export const REWARD_DIST_ADDRESS = deploymentFile.RewardsDistributer.address;

type Metadata = { name: string; url: string };

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

export function getDelegationId(delegator: string, indexer: string): string {
  return `${delegator}:${indexer}`;
}

export function getWithdrawlId(delegator: string, index: BigNumber): string {
  return `${delegator}:${index.toHexString()}`;
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

const metadataHost = 'https://unauthipfs.subquery.network/ipfs/api/v0/cat?arg=';

export async function decodeMetadata(
  metadataCID: string
): Promise<Metadata | undefined> {
  try {
    const url = `${metadataHost}${metadataCID}`;
    const response = await fetch(url, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
    });

    const metadata = response.json() as unknown as Metadata;
    logger.info(`Fetched metadata from cid: ${metadataCID}`);
    return metadata;
  } catch (error) {
    logger.error(`Cannot decode metadata from cid: ${metadataCID}`);
    logger.error(error);
    return undefined;
  }
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

    const stakeCurr = BigNumber.from(indexerStake?.value.value ?? 0);
    const stakeAfter = BigNumber.from(indexerStake?.valueAfter.value ?? 0);

    const totalStakeCurr = BigNumber.from(indexerTotalStake?.value.value ?? 0);
    const totalStakeAfter = BigNumber.from(
      indexerTotalStake?.valueAfter.value ?? 0
    );

    const current =
      stakeCurr?.mul(leverageLimit).sub(totalStakeCurr || 0) ||
      BigNumber.from(0);
    const after =
      stakeAfter?.mul(leverageLimit).sub(totalStakeAfter || 0) ||
      BigNumber.from(0);

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
