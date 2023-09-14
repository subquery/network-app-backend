import { Cache } from '../../types';
import { BigNumber } from '@ethersproject/bignumber';

export enum CacheKey {
  Era = 'era',
  MinimumStakingAmount = 'minimumStakingAmount',
  IndexerLeverageLimit = 'indexerLeverageLimit',
}

export async function cacheSet(key: CacheKey, value: string) {
  await Cache.create({
    id: key.toString(),
    value: value,
  }).save();
}

export async function cacheGet(key: CacheKey): Promise<string | undefined> {
  return (await Cache.get(key.toString()))?.value;
}

export async function cacheGetNumber(
  key: CacheKey
): Promise<number | undefined> {
  const cached = await Cache.get(key.toString());
  return cached ? Number(cached.value) : undefined;
}

export async function cacheGetBigNumber(
  key: CacheKey
): Promise<BigNumber | undefined> {
  const cached = await Cache.get(key.toString());
  return cached ? BigNumber.from(cached.value) : undefined;
}
