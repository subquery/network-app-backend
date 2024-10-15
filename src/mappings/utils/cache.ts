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
  BoosterQueryRewardRate = 'boosterQueryRewardRate',
  BoosterQueryRewardRateSubquery = 'boosterQueryRewardRateSubquery',
  BoosterQueryRewardRateRpc = 'boosterQueryRewardRateRpc',
  BoosterQueryRewardRateSqDict = 'boosterQueryRewardRateSqDict',
  BoosterQueryRewardRateSubgraph = 'boosterQueryRewardRateSubgraph',
  BoosterQueryRewardRateLlm = 'boosterQueryRewardRateLlm',
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
  [CacheKey.BoosterQueryRewardRateSubquery]: 'uint256',
  [CacheKey.BoosterQueryRewardRateRpc]: 'uint256',
  [CacheKey.BoosterQueryRewardRateSqDict]: 'uint256',
  [CacheKey.BoosterQueryRewardRateSubgraph]: 'uint256',
  [CacheKey.BoosterQueryRewardRateLlm]: 'uint256',
};

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

export async function cacheRemove(key: CacheKey) {
  await Cache.remove(key.toString());
}
