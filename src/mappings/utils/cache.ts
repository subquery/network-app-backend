import { Cache } from '../../types';
import { BigNumber } from '@ethersproject/bignumber';

export enum CacheKey {
  Era = 'era',
  MinimumStakingAmount = 'minimumStakingAmount',
  IndexerLeverageLimit = 'indexerLeverageLimit',
  SettleDestination = 'settleDestination',
  FeePerMill = 'feePerMill',
  MinimumDeposit = 'minimumDeposit',
  MinimumCommissionRate = 'minimumCommissionRate',
  TradeLimitation = 'tradeLimitation',
  TradeLimitationPerAccount = 'tradeLimitationPerAccount',
  Limit = 'limit',
  SizeLimit = 'sizeLimit',
  BlockLimit = 'blockLimit',
  PenaltyRate = 'penaltyRate',
  PenaltyDestination = 'penaltyDestination',
  IssuancePerBlock = 'issuancePerBlock',
  MinimumDeploymentBooster = 'minimumDeploymentBooster',
  MaxCommissionFactor = 'maxCommissionFactor',
  MaxRewardFactor = 'maxRewardFactor',
  AlphaNumerator = 'alphaNumerator',
  AlphaDenominator = 'alphaDenominator',
  Redeemable = 'redeemable',
  MaxUnbondingRequest = 'maxUnbondingRequest',
  UnbondFeeRate = 'unbondFeeRate',
  LockPeriod = 'lockPeriod',
  TerminateExpiration = 'terminateExpiration',
  EraPeriod = 'eraPeriod',
  Maintenance = 'maintenance',
}

export const DecimalCacheKey = [
  CacheKey.Era,
  CacheKey.MinimumStakingAmount,
  CacheKey.IndexerLeverageLimit,
];

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
