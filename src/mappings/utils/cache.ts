import { Cache, ProjectType } from '../../types';
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
  BoosterQueryRewardRate = 'boosterQueryRewardRate',
}

export const CacheKeyToParamType = {
  [CacheKey.Era]: 'uint256',
  [CacheKey.MinimumStakingAmount]: 'uint256',
  [CacheKey.IndexerLeverageLimit]: 'uint256',
  [CacheKey.SettleDestination]: 'address',
  [CacheKey.FeePerMill]: 'uint256',
  [CacheKey.MinimumDeposit]: 'uint256',
  [CacheKey.MinimumCommissionRate]: 'uint256',
  [CacheKey.TradeLimitation]: 'uint256',
  [CacheKey.TradeLimitationPerAccount]: 'uint256',
  [CacheKey.Limit]: 'uint256',
  [CacheKey.SizeLimit]: 'uint256',
  [CacheKey.BlockLimit]: 'uint256',
  [CacheKey.PenaltyRate]: 'uint256',
  [CacheKey.PenaltyDestination]: 'address',
  [CacheKey.IssuancePerBlock]: 'uint256',
  [CacheKey.MinimumDeploymentBooster]: 'uint256',
  [CacheKey.MaxCommissionFactor]: 'uint256',
  [CacheKey.MaxRewardFactor]: 'uint256',
  [CacheKey.AlphaNumerator]: 'uint256',
  [CacheKey.AlphaDenominator]: 'uint256',
  [CacheKey.Redeemable]: 'bool',
  [CacheKey.MaxUnbondingRequest]: 'uint256',
  [CacheKey.UnbondFeeRate]: 'uint256',
  [CacheKey.LockPeriod]: 'uint256',
  [CacheKey.TerminateExpiration]: 'uint256',
  [CacheKey.EraPeriod]: 'uint256',
  [CacheKey.Maintenance]: 'bool',
  [CacheKey.BoosterQueryRewardRate]: 'uint256',
};

export const BoosterQueryRewardRateKeys = {
  [ProjectType.SUBQUERY]:
    CacheKey.BoosterQueryRewardRate + ProjectType.SUBQUERY,
  [ProjectType.RPC]: CacheKey.BoosterQueryRewardRate + ProjectType.RPC,
  [ProjectType.SQ_DICT]: CacheKey.BoosterQueryRewardRate + ProjectType.SQ_DICT,
  [ProjectType.SUBGRAPH]:
    CacheKey.BoosterQueryRewardRate + ProjectType.SUBGRAPH,
};

export async function cacheSet(key: string, value: string) {
  await Cache.create({
    id: key.toString(),
    value: value,
  }).save();
}

export async function cacheGet(key: string): Promise<string | undefined> {
  return (await Cache.get(key.toString()))?.value;
}

export async function cacheGetNumber(key: string): Promise<number | undefined> {
  const cached = await Cache.get(key.toString());
  return cached ? Number(cached.value) : undefined;
}

export async function cacheGetBigNumber(
  key: string
): Promise<BigNumber | undefined> {
  const cached = await Cache.get(key.toString());
  return cached ? BigNumber.from(cached.value) : undefined;
}

export async function cacheRemove(key: string) {
  await Cache.remove(key.toString());
}
