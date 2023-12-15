// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { EthereumLog } from '@subql/types-ethereum';
import { NewEraStartEvent } from '@subql/contract-sdk/typechain/Contracts/polygon/EraManager';
import assert from 'assert';
import { Era } from '../types';
import { biToDate, Contracts, getContractAddress } from './utils';
import { EraManager__factory } from '../types/contracts/factories/EraManager__factory';
import { cacheGetNumber, CacheKey, cacheSet } from './utils/cache';

/* Era Handlers */
export async function handleNewEra(
  event: EthereumLog<NewEraStartEvent['args']>
): Promise<void> {
  logger.info('handleNewEra');
  assert(event.args, 'No event args');
  const { era: id } = event.args;

  await cacheSet(CacheKey.Era, id.toString());

  if (id.gt(1)) {
    const previousId = id.sub(1);
    const previousEra = await Era.get(previousId.toHexString());
    if (previousEra) {
      previousEra.endTime = biToDate(event.block.timestamp);
      previousEra.lastEvent = `handleNewEra:${event.blockNumber}`;
      await previousEra.save();
    } else {
      const network = await api.getNetwork();
      const eraManager = EraManager__factory.connect(
        getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
        api
      );
      const eraPeriod = await eraManager.eraPeriod();

      const a = biToDate(event.block.timestamp);
      const startTime = new Date(
        a.getTime() - eraPeriod.toNumber() * 1000 // eraPeriod: seconds unit
      );

      const previousEra = Era.create({
        id: previousId.toHexString(),
        startTime,
        endTime: biToDate(event.block.timestamp),
        forceNext: true,
        createdBlock: event.blockNumber,
      });
      await previousEra.save();
    }
  }

  const era = Era.create({
    id: id.toHexString(),
    startTime: biToDate(event.block.timestamp),
    forceNext: false,
    createdBlock: event.blockNumber,
  });

  await era.save();
}

export async function getCurrentEra(): Promise<number> {
  let era = await cacheGetNumber(CacheKey.Era);
  if (era === undefined) {
    const network = await api.getNetwork();
    const eraManager = EraManager__factory.connect(
      getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
      api
    );
    era = await eraManager.eraNumber().then((r) => r.toNumber());
    await cacheSet(CacheKey.Era, era!.toString());
  }
  return era!;
}
