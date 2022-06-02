// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import { NewEraStartEvent } from '@subql/contract-sdk/typechain/EraManager';
import assert from 'assert';

import { Era } from '../types';

/* Era Handlers */
export async function handleNewEra(
  event: AcalaEvmEvent<NewEraStartEvent['args']>
): Promise<void> {
  logger.info('handleNewEra');
  assert(event.args, 'No event args');

  const { era: id } = event.args;

  // FIXME: set back to 1
  if (id.gt(2)) {
    const previousId = id.sub(1);
    const previousEra = await Era.get(previousId.toHexString());
    assert(previousEra, `Era ${previousId.toNumber()} doesn't exist`);

    previousEra.endTime = event.blockTimestamp;

    await previousEra.save();
  }

  const era = Era.create({
    id: id.toHexString(),
    startTime: event.blockTimestamp,
  });

  await era.save();
}
