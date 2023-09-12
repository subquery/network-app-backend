// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ChannelCheckpointEvent,
  ChannelExtendEvent,
  ChannelFinalizeEvent,
  ChannelFundEvent,
  ChannelOpenEvent,
  ChannelTerminateEvent,
} from '@subql/contract-sdk/typechain/StateChannel';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { logger, utils } from 'ethers';
import { ChannelStatus, StateChannel } from '../types';
import { biToDate, bytesToIpfsCid } from './utils';

export async function handleChannelOpen(
  event: EthereumLog<ChannelOpenEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');

  const {
    channelId,
    indexer,
    consumer: _consumer,
    total,
    price,
    expiredAt,
    deploymentId,
    callback,
  } = event.args;

  logger.info(
    `handleChannelOpen: channel: ${channelId.toHexString()}, at ${
      event.blockNumber
    }-${event.blockHash}-${event.transactionHash}`
  );
  let consumer = _consumer;
  let agent: string | undefined = undefined;
  try {
    consumer = utils.defaultAbiCoder.decode(['address'], callback)[0] as string;
    agent = _consumer;
  } catch (e) {
    logger.info(`Channel created by ${indexer}`);
  }

  const sc = StateChannel.create({
    id: channelId.toHexString(),
    indexer,
    consumer,
    agent,
    status: ChannelStatus.OPEN,
    total: total.toBigInt(),
    price: price.toBigInt(),
    spent: BigInt(0),
    isFinal: false,
    expiredAt: new Date(expiredAt.toNumber() * 1000),
    deploymentId: bytesToIpfsCid(deploymentId),
    terminateByIndexer: false,
    startTime: biToDate(event.block.timestamp),
    lastEvent: `handleChannelOpen:${event.transactionHash}`,
  });

  await sc.save();
  logger.info(`handleChannelOpen Done: channel: ${channelId.toHexString()}`);
}

export async function handleChannelExtend(
  event: EthereumLog<ChannelExtendEvent['args']>
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
  event: EthereumLog<ChannelFundEvent['args']>
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
  event: EthereumLog<ChannelCheckpointEvent['args']>
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
  event: EthereumLog<ChannelTerminateEvent['args']>
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
  event: EthereumLog<ChannelFinalizeEvent['args']>
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
