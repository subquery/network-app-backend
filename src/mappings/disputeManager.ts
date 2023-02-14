// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  DisputeFinalizedEvent,
  DisputeOpenEvent,
} from '@subql/contract-sdk/typechain/DisputeManager';
import { FrontierEvmEvent } from '@subql/frontier-evm-processor';
import assert from 'assert';
import { Disputes, DisputeState, DisputeType } from '../types';

function getDisputeType(type: number): DisputeType {
  switch (type) {
    case 0:
      return DisputeType.POI;
    case 1:
      return DisputeType.QUERY;
    default:
      throw new Error(
        `Unexpected dispute type "${type}" provided to function getDisputeType`
      );
  }
}

function getDisputeState(state: number): DisputeState {
  switch (state) {
    case 0:
      return DisputeState.ONGOING;
    case 1:
      return DisputeState.ACCEPTED;
    case 2:
      return DisputeState.REJECTED;
    case 3:
      return DisputeState.CANCELLED;
    default:
      throw new Error(
        `Unexpected dispute state "${state}" provided to function getDisputeState`
      );
  }
}

export async function handleDisputeOpen(
  event: FrontierEvmEvent<DisputeOpenEvent['args']>
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
  event: FrontierEvmEvent<DisputeFinalizedEvent['args']>
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
