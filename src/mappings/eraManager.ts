// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { EthereumLog } from '@subql/types-ethereum';
import { NewEraStartEvent } from '@subql/contract-sdk/typechain/EraManager';
import { EraManager__factory } from '@subql/contract-sdk';
import assert from 'assert';
import { Era } from '../types';
import { biToDate, Contracts, getContractAddress } from './utils';

let globalCurrentEra = -1;

/* Era Handlers */
export async function handleNewEra(
  event: EthereumLog<NewEraStartEvent['args']>
): Promise<void> {
  logger.info('handleNewEra');
  assert(event.args, 'No event args');
  const { era: id } = event.args;

  updateGlobalCurrentEra(id.toNumber());

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

function updateGlobalCurrentEra(era: number): void {
  globalCurrentEra = era;
}

export async function getCurrentEra(): Promise<number> {
  if (globalCurrentEra === -1) {
    const network = await api.getNetwork();
    const eraManager = EraManager__factory.connect(
      getContractAddress(network.chainId, Contracts.ERA_MANAGER_ADDRESS),
      api
    );
    updateGlobalCurrentEra(
      await eraManager.eraNumber().then((r) => r.toNumber())
    );
  }
  return globalCurrentEra;
}
