// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import {
  PurchaseOfferCreatedEvent,
  PurchaseOfferCancelledEvent,
  OfferAcceptedEvent,
} from '@subql/contract-sdk/typechain/PurchaseOfferMarket';
import { EthereumLog } from '@subql/types-ethereum';
import { Offer, AcceptedOffer } from '../types';
import { bytesToIpfsCid } from './utils';

export async function handlePurchaseOfferCreated(
  event: EthereumLog<PurchaseOfferCreatedEvent['args']>
): Promise<void> {
  logger.info('handlePurchaseOfferCreated');
  assert(event.args, 'No event args');

  const offer = Offer.create({
    id: event.args.offerId.toString(),
    consumer: event.args.consumer,
    deploymentId: bytesToIpfsCid(event.args.deploymentId),
    planTemplateId: event.args.planTemplateId.toHexString(),
    deposit: event.args.deposit.toBigInt(),
    minimumAcceptHeight: event.args.minimumAcceptHeight.toBigInt(),
    expireDate: new Date(event.args.expireDate.toNumber() * 1000), // seconds return from contract and manipulate into milliseconds / Date object.
    limit: event.args.limit,
    accepted: 0,
    reachLimit: false,
    withdrawn: false,
    createdBlock: event.blockNumber,
  });

  await offer.save();
}

export async function handlePurchaseOfferCancelled(
  event: EthereumLog<PurchaseOfferCancelledEvent['args']>
): Promise<void> {
  logger.info('handlePurchaseOfferCancelled');
  assert(event.args, 'No event args');

  const offer = await Offer.get(event.args.offerId.toString());
  assert(offer, `offer not found. offerID="${event.args.offerId.toString()}"`);

  offer.expireDate = new Date(Number(event.block.timestamp));
  offer.withdrawn = true;
  offer.withdrawPenalty = event.args.penalty.toBigInt();
  offer.lastEvent = `handlePurchaseOfferCancelled:${event.blockNumber}`;

  await offer.save();
}

export async function handlePurchaseOfferAccepted(
  event: EthereumLog<OfferAcceptedEvent['args']>
): Promise<void> {
  logger.info('handlePurchaseOfferAccepted');
  assert(event.args, 'No event args');

  const eventOfferId = event.args.offerId.toString();
  const eventAgreementId = event.args.agreementId.toString();

  const offer = await Offer.get(eventOfferId);
  assert(offer, `offer not found. offerID="${eventOfferId}"`);

  try {
    if (offer.accepted < offer.limit) {
      const acceptedAmount = offer.accepted + 1;
      offer.accepted = acceptedAmount;
      offer.reachLimit = acceptedAmount === offer.limit;
      offer.lastEvent = `handlePurchaseOfferAccepted:${event.blockNumber}`;

      await offer.save();

      const acceptedOffer = AcceptedOffer.create({
        id: `${eventOfferId}:${event.args.indexer}`,
        indexerId: event.args.indexer,
        offerId: eventOfferId,
        serviceAgreementId: eventAgreementId,
        createdBlock: event.blockNumber,
      });

      await acceptedOffer.save();
    } else {
      throw new Error(
        'Method handlePurchaseOfferAccepted: max limit of offer acceptance exceed.'
      );
    }
  } catch (e) {
    logger.info('handlePurchaseOfferAccepted', JSON.stringify(event, null, 2));
    logger.error(e);
  }
}
