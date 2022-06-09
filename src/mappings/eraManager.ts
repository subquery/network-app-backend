// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import { NewEraStartEvent } from '@subql/contract-sdk/typechain/EraManager';
import { EraManager__factory } from '@subql/contract-sdk';
import assert from 'assert';
import { Era } from '../types';
import { ERA_MANAGER_ADDRESS } from './utils';
import FrontierEthProvider from './ethProvider';

/* Era Handlers */
export async function handleNewEra(
  event: AcalaEvmEvent<NewEraStartEvent['args']>
): Promise<void> {
  logger.info('handleNewEra');
  assert(event.args, 'No event args');

  const { era: id } = event.args;

  if (id.gt(1)) {
    const previousId = id.sub(1);
    const previousEra = await Era.get(previousId.toHexString());
    if (previousEra) {
      previousEra.endTime = event.blockTimestamp;
      await previousEra.save();
    } else {
      const eraManager = EraManager__factory.connect(
        ERA_MANAGER_ADDRESS,
        new FrontierEthProvider()
      );

      const eraPeriod = await eraManager.eraPeriod();
      const startTime = new Date(
        event.blockTimestamp.getTime() - eraPeriod.toNumber() * 1000 // eraPeriod: seconds unit
      );
      const endTime = event.blockTimestamp;

      const previousEra = Era.create({
        id: previousId.toHexString(),
        startTime,
        endTime,
        forceNext: true,
      });
      await previousEra.save();
    }
  }

  const era = Era.create({
    id: id.toHexString(),
    startTime: event.blockTimestamp,
    forceNext: false,
  });

  await era.save();
}
