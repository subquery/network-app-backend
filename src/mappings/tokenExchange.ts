// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ExchangeOrderSentEvent,
  OrderSettledEvent,
  TradeEvent,
} from '@subql/contract-sdk/typechain/contracts/TokenExchange';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { Order, OrderStatus, Trade, Trader } from '../types';
import { biToDate } from './utils';

export async function handleExchangeOrderSent(
  event: EthereumLog<ExchangeOrderSentEvent['args']>
): Promise<void> {
  logger.info('handleExchangeOrderSent');
  assert(event.args, 'No event args');

  const {
    orderId,
    sender,
    tokenGive,
    tokenGet,
    amountGive,
    amountGet,
    tokenGiveBalance,
  } = event.args;

  const order = Order.create({
    id: orderId.toString(),
    sender,
    tokenGive,
    tokenGet,
    amountGive: amountGive.toBigInt(),
    amountGet: amountGet.toBigInt(),
    tokenGiveBalance: tokenGiveBalance.toBigInt(),
    status: OrderStatus.ACTIVE,
    createAt: biToDate(event.block.timestamp),
    updateAt: biToDate(event.block.timestamp),
  });

  await order.save();
}

export async function handleOrderSettled(
  event: EthereumLog<OrderSettledEvent['args']>
): Promise<void> {
  logger.info('handleOrderSettled');
  assert(event.args, 'No event args');

  const { orderId, amountGive } = event.args;
  const order = await Order.get(orderId.toString());
  assert(order, `Order ${orderId.toString()} not found`);

  order.status = OrderStatus.INACTIVE;
  order.tokenGiveBalance = amountGive.toBigInt();
  order.updateAt = biToDate(event.block.timestamp);

  await order.save();
}

export async function handleTraded(
  event: EthereumLog<TradeEvent['args']>
): Promise<void> {
  logger.info('handleTraded');
  assert(event.args, 'No event args');

  const { orderId, tokenGive, tokenGet, amountGive, amountGet } = event.args;

  const sender = event.transaction.from;
  let trader = await Trader.get(sender);
  if (!trader) {
    trader = Trader.create({
      id: sender,
      totalSwapSQTAmount: amountGive.toBigInt(),
      totalSwapkSQTAmount: amountGet.toBigInt(),
      createAt: biToDate(event.block.timestamp),
      updateAt: biToDate(event.block.timestamp),
    });
  } else {
    trader.totalSwapSQTAmount += amountGive.toBigInt();
    trader.totalSwapkSQTAmount += amountGet.toBigInt();
    trader.updateAt = biToDate(event.block.timestamp);
  }

  await trader.save();

  const tradeRecord = Trade.create({
    id: `${orderId.toString()}:${event.transaction.hash}`,
    senderId: sender,
    tokenGive,
    tokenGet,
    amountGive: amountGive.toBigInt(),
    amountGet: amountGet.toBigInt(),
    createAt: biToDate(event.block.timestamp),
    updateAt: biToDate(event.block.timestamp),
  });

  await tradeRecord.save();
}
