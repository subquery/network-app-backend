// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  PurchaseOfferCreatedEvent,
  PurchaseOfferCancelledEvent,
} from '@subql/contract-sdk/typechain/PurchaseOfferMarket';
import { PurchaseOfferMarket__factory } from '@subql/contract-sdk';
import { AcalaEvmEvent } from '@subql/acala-evm-processor';
import FrontierEthProvider from './ethProvider';
import { Offer } from '../types';
import { bytesToIpfsCid } from './utils';
import { ClosedAgreementCreatedEvent } from '@subql/contract-sdk/typechain/ServiceAgreementRegistry';

// TODO: to confirm expireDate -  should be Date type
// TODO: to confirm offerID - should expose from event args
export async function handlePurchaseOfferCreated(
  event: AcalaEvmEvent<PurchaseOfferCreatedEvent['args']>
): Promise<void> {
  logger.info('handlePurchaseOfferCreated');
  assert(event.args, 'No event args');

  const offerContract = PurchaseOfferMarket__factory.connect(
    event.args.consumer,
    new FrontierEthProvider()
  );
  const offerId = await offerContract.numOffers();

  const offer = Offer.create({
    id: offerId.toString(),
    consumer: event.args.consumer,
    deploymentId: bytesToIpfsCid(event.args.deploymentId),
    planTemplateId: event.args.planTemplateId.toHexString(),
    deposit: event.args.deposit.toBigInt(),
    minimumAcceptHeight: event.args.minimumAcceptHeight.toBigInt(),
    expireDate: new Date(event.args.expireDate.toString()),
    limit: event.args.limit,
    accepted: 0,
    reachLimit: false,
    withdrawn: false,
  });

  await offer.save();
}

export async function handlePurchaseOfferCancelled(
  event: AcalaEvmEvent<PurchaseOfferCancelledEvent['args']>
): Promise<void> {
  logger.info('handlePurchaseOfferCancelled');
  assert(event.args, 'No event args');

  const offer = await Offer.get(event.args.offerId.toString());
  assert(offer, `offer not found. planId="${event.args.offerId.toString()}"`);

  offer.expireDate = new Date(event.blockTimestamp);
  offer.withdrawn = true;
  offer.withdrawPenalty = event.args.penalty.toBigInt();

  await offer.save();
}

// export async function handlePurchaseOfferAccepted(
//   event: AcalaEvmEvent<ClosedAgreementCreatedEvent['args']>
// ): Promise<void> {
//   logger.info('handlePurchaseOfferCancelled');
//   assert(event.args, 'No event args');

//   const offer = await Offer.get(event.args.offerId.toString());
//   assert(offer, `offer not found. planId="${event.args.offerId.toString()}"`);

//   const acceptedAmount = offer.accepted + 1;
//   offer.accepted = acceptedAmount;
//   offer.reachLimit = acceptedAmount === offer.limit;

//   await offer.save();
// }
