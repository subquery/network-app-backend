// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import { ClosedAgreementCreatedEvent } from '@subql/contract-sdk/typechain/ServiceAgreementRegistry';
import { ServiceAgreement } from '../types';
import { bytesToIpfsCid } from './utils';
import { IServiceAgreement__factory } from '@subql/contract-sdk';
import FrontierEthProvider from './ethProvider';
import { AcalaEvmEvent } from '@subql/acala-evm-processor';

export async function handleServiceAgreementCreated(
  event: AcalaEvmEvent<ClosedAgreementCreatedEvent['args']>
): Promise<void> {
  logger.info('handleClosedServiceAgreementCreated');
  assert(event.args, 'No event args');

  const saContract = IServiceAgreement__factory.connect(
    event.args.serviceAgreement,
    new FrontierEthProvider()
  );

  const [period, value] = await Promise.all([
    saContract.period(),
    saContract.value(),
  ]);

  const endTime = new Date(event.blockTimestamp);

  endTime.setSeconds(endTime.getSeconds() + period.toNumber());

  const sa = ServiceAgreement.create({
    id: event.args.serviceAgreement,
    indexerAddress: event.args.indexer,
    consumerAddress: event.args.consumer,
    deploymentId: bytesToIpfsCid(event.args.deploymentId),
    period: period.toBigInt(),
    value: value.toBigInt(),
    startTime: event.blockTimestamp,
    endTime,
  });

  await sa.save();
}
