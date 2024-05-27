import { ParameterEvent } from '@subql/contract-sdk/typechain/contracts/Airdropper';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { CacheKey, DecimalCacheKey, cacheSet } from './cache';
import { BigNumber } from 'ethers';

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

    let cacheValue: string = value;
    if (DecimalCacheKey.includes(name as CacheKey)) {
      cacheValue = BigNumber.from(value).toString();
    }

    await cacheSet(name as CacheKey, cacheValue);
  };
}
