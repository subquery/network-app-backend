// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  DisputeFinalizedEvent,
  DisputeOpenEvent,
} from '@subql/contract-sdk/typechain/contracts/DisputeManager';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { Disputes, DisputeState } from '../types';
import { getDisputeState, getDisputeType } from './utils/enumToTypes';

export async function handleDisputeOpen(
  event: EthereumLog<DisputeOpenEvent['args']>
): Promise<void> {
  logger.info('handleDisputeOpen');
  assert(event.args, 'No event args');

  const { disputeId, fisherman, indexer, _type } = event.args;

  const disputeType = getDisputeType(_type);

  const dispute = Disputes.create({
    id: disputeId.toHexString(),
    state: DisputeState.ONGOING,
    disputeType,
    isFinalized: false,
    indexer,
    fisherman,
  });

  await dispute.save();
}

export async function handleDisputeFinalized(
  event: EthereumLog<DisputeFinalizedEvent['args']>
): Promise<void> {
  logger.info('handleDisputeFinalized');
  assert(event.args, 'No event args');

  const { disputeId, state: _state, slashAmount, returnAmount } = event.args;

  const state = getDisputeState(_state);
  const dispute = await Disputes.get(disputeId.toHexString());

  assert(dispute, `Dispute not found. disputeId="${disputeId.toHexString()}"`);

  dispute.isFinalized = true;
  dispute.state = state;
  (dispute.slashAmount = slashAmount.toBigInt()),
    (dispute.returnAmount = returnAmount.toBigInt());
  await dispute.save();
}
