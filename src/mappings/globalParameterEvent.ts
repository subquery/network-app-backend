import { ParameterEvent } from '@subql/contract-sdk/typechain/contracts/Airdropper';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import {
  BoosterQueryRewardRateKeys,
  CacheKey,
  CacheKeyToParamType,
  cacheRemove,
  cacheSet,
} from './utils/cache';
import { defaultAbiCoder } from '@ethersproject/abi';
import { ProjectType } from '../types';

export async function handleParameterEvent(
  event: EthereumLog<ParameterEvent['args']>
): Promise<void> {
  logger.info('handleParameterEvent');
  assert(event.args, 'No event args');

  const { name, value } = event.args;

  switch (name) {
    case CacheKey.BoosterQueryRewardRate: {
      await boostQueryRewardRateHandler(value);
      break;
    }
    default: {
      await defaultHandler(name, value);
      break;
    }
  }
}

async function boostQueryRewardRateHandler(value: string) {
  if (value.startsWith('0x')) {
    value = value.slice(2);
  }
  if (value.length <= 64) {
    return await cacheSet(CacheKey.BoosterQueryRewardRate, value);
  }
  await cacheRemove(CacheKey.BoosterQueryRewardRate);
  const [enumValue, uint256Value] = splitEnumAndUint256(value);
  let cacheKey = '';
  switch (enumValue) {
    case 0:
      cacheKey = BoosterQueryRewardRateKeys[ProjectType.SUBQUERY];
      break;
    case 1:
      cacheKey = BoosterQueryRewardRateKeys[ProjectType.RPC];
      break;
    case 2:
      cacheKey = BoosterQueryRewardRateKeys[ProjectType.SQ_DICT];
      break;
    case 3:
      cacheKey = BoosterQueryRewardRateKeys[ProjectType.SUBGRAPH];
      break;
    default:
      return;
  }
  await cacheSet(cacheKey, uint256Value);
}

function splitEnumAndUint256(value: string): [number, string] {
  if (value.startsWith('0x')) {
    value = value.slice(2);
  }
  const enumValue = parseInt(value.slice(0, 2), 16);
  const uint256Value = value.slice(2);
  return [
    enumValue,
    defaultAbiCoder.decode(['uint256'], `0x${uint256Value}`).toString(),
  ];
}

async function defaultHandler(name: string, value: string) {
  const paramType = CacheKeyToParamType[name as CacheKey] || 'string';
  const cacheValue = defaultAbiCoder.decode([paramType], value);
  await cacheSet(name, cacheValue.toString());
}
