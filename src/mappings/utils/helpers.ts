// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import bs58 from 'bs58';
import { BigNumber } from '@ethersproject/bignumber';
import keplerDeploymentFile from '@subql/contract-sdk/publish/kepler.json';
import testnetDeploymentFile from '@subql/contract-sdk/publish/kepler.json';
import { EthereumLog } from '@subql/types-ethereum';

import { JSONBigInt, Exception } from '../../types';
import assert from 'assert';

export enum Contracts {
  QUERY_REGISTRY_ADDRESS = 'QueryRegistry',
  ERA_MANAGER_ADDRESS = 'EraManager',
  STAKING_ADDRESS = 'Staking',
  INDEXER_REGISTRY_ADDRESS = 'IndexerRegistry',
  PLAN_MANAGER_ADDRESS = 'PlanManager',
  SA_REGISTRY_ADDRESS = 'ServiceAgreementRegistry',
  REWARD_DIST_ADDRESS = 'RewardsDistributer',
}

export function getContractAddress(
  networkId: number,
  contract: Contracts
): string {
  const deploymentFile =
    networkId === 80001 ? testnetDeploymentFile : keplerDeploymentFile;
  // logger.info(
  //   `${networkId}: ${contract} ${
  //     deploymentFile[contract as keyof typeof deploymentFile].address
  //   }`
  // );
  return deploymentFile[contract as keyof typeof deploymentFile].address;
}

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
    throw new Error('Value is not JSONBigInt');
  }

  return BigNumber.from(value.value).toBigInt();
};

export function bigNumbertoJSONType(value: BigNumber): JSONBigInt {
  return {
    type: 'bigint',
    value: value.toHexString(),
  };
}

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

export function biToDate(bi: bigint): Date {
  return new Date(Number(bi) * 1000);
}

export const operations: Record<string, (a: bigint, b: bigint) => bigint> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  replace: (a, b) => b,
};

export function min(a: BigNumber, b: BigNumber): BigNumber {
  return a.lte(b) ? a : b;
}

export function getDelegationId(delegator: string, indexer: string): string {
  return `${delegator}:${indexer}`;
}

export function getWithdrawlId(delegator: string, index: BigNumber): string {
  return `${delegator}:${index.toHexString()}`;
}

export function bigNumberFrom(value: unknown): BigNumber {
  try {
    return BigNumber.from(value);
  } catch (e) {
    return BigNumber.from(0);
  }
}

export async function reportIndexerNonExistException(
  handler: string,
  indexerAddress: string,
  event: EthereumLog<any>
): Promise<void> {
  logger.error(`${handler}: Expected indexer to exist: ${indexerAddress}`);

  return reportException(
    handler,
    `Expected indexer to exist: ${indexerAddress}`,
    event
  );
}

export async function reportException(
  handler: string,
  error: string,
  event: EthereumLog<any>
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
