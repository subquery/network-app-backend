import { ParameterEvent } from '@subql/contract-sdk/typechain/contracts/Airdropper';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { CacheKey, CacheKeyToParamType, cacheSet } from './cache';
import { defaultAbiCoder } from '@ethersproject/abi';

type HandleParameterEventFunc = (
  event: EthereumLog<ParameterEvent['args']>
) => Promise<void>;

export function genHandleParameterEvent(abi: string): HandleParameterEventFunc {
  const HANDLER = abi + ':handleParameterEvent';

  return async function (
    event: EthereumLog<ParameterEvent['args']>
  ): Promise<void> {
    logger.info(HANDLER);
    assert(event.args, 'No event args');

    const { name, value } = event.args;

    const paramType = CacheKeyToParamType[name as CacheKey] || 'string';

    const cacheValue = defaultAbiCoder.decode([paramType], value);
    await cacheSet(name as CacheKey, cacheValue.toString());
  };
}
