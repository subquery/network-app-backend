// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  ChannelOpenEvent,
  ChannelExtendEvent,
  ChannelFundEvent,
  ChannelCheckpointEvent,
  ChannelTerminateEvent,
  ChannelFinalizeEvent,
} from '@subql/contract-sdk/typechain/StateChannel';
import { StateChannel, ChannelStatus } from '../types';
import { bytesToIpfsCid } from './utils';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';

export async function handleChannelOpen(
  event: FrontierEvmEvent<ChannelOpenEvent['args']>
): Promise<void> {
  logger.info('handleChannelOpen');
  assert(event.args, 'No event args');

  const { channelId, indexer, consumer, total, expiredAt, deploymentId } =
    event.args;

  const sc = StateChannel.create({
    id: channelId.toHexString(),
    indexer: indexer,
    consumer: consumer,
    status: ChannelStatus.OPEN,
    total: total.toBigInt(),
    spent: BigInt(0),
    isFinal: false,
    expiredAt: new Date(expiredAt.toNumber() * 1000),
    terminatedAt: new Date(expiredAt.toNumber() * 1000),
    deploymentId: bytesToIpfsCid(deploymentId),
    terminateByIndexer: false,
    startTime: event.blockTimestamp,
  });

  await sc.save();
}

export async function handleChannelExtend(
  event: FrontierEvmEvent<ChannelExtendEvent['args']>
): Promise<void> {
  logger.info('handleChannelExtend');
  assert(event.args, 'No event args');

  const { channelId, expiredAt } = event.args;
  const sc = await StateChannel.get(channelId.toHexString());
  assert(sc, `Expected StateChannel (${channelId.toHexString()}) to exist`);
  sc.expiredAt = new Date(expiredAt.toNumber() * 1000);
  await sc.save();
}

export async function handleChannelFund(
  event: FrontierEvmEvent<ChannelFundEvent['args']>
): Promise<void> {
  logger.info('handleChannelFund');
  assert(event.args, 'No event args');

  const { channelId, total } = event.args;
  const sc = await StateChannel.get(channelId.toHexString());
  assert(sc, `Expected StateChannel (${channelId.toHexString()}) to exist`);
  sc.total = total.toBigInt();
  await sc.save();
}

export async function handleChannelCheckpoint(
  event: FrontierEvmEvent<ChannelCheckpointEvent['args']>
): Promise<void> {
  logger.info('handleChannelCheckpoint');
  assert(event.args, 'No event args');

  const { channelId, spent } = event.args;
  const sc = await StateChannel.get(channelId.toHexString());
  assert(sc, `Expected StateChannel (${channelId.toHexString()}) to exist`);
  sc.spent = spent.toBigInt();
  await sc.save();
}

export async function handleChannelTerminate(
  event: FrontierEvmEvent<ChannelTerminateEvent['args']>
): Promise<void> {
  logger.info('handleChannelTerminate');
  assert(event.args, 'No event args');

  const { channelId, spent, terminatedAt, terminateByIndexer } = event.args;
  const sc = await StateChannel.get(channelId.toHexString());
  assert(sc, `Expected StateChannel (${channelId.toHexString()}) to exist`);
  sc.spent = spent.toBigInt();
  sc.status = ChannelStatus.TERMINATING;
  sc.terminatedAt = new Date(terminatedAt.toNumber() * 1000);
  sc.terminateByIndexer = terminateByIndexer;
  await sc.save();
}

export async function handleChannelFinalize(
  event: FrontierEvmEvent<ChannelFinalizeEvent['args']>
): Promise<void> {
  logger.info('handleChannelCheckpoint');
  assert(event.args, 'No event args');

  const { channelId, total, remain } = event.args;
  const sc = await StateChannel.get(channelId.toHexString());
  assert(sc, `Expected StateChannel (${channelId.toHexString()}) to exist`);
  sc.status = ChannelStatus.FINALIZED;
  sc.spent = total.toBigInt() - remain.toBigInt();
  await sc.save();
}
