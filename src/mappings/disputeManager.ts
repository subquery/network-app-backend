// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  DisputeFinalizedEvent,
  DisputeOpenEvent,
} from '@subql/contract-sdk/typechain/DisputeManager';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { Disputes, DisputeState, DisputeType } from '../types';

function getDisputeType(type: number): DisputeType {
  const typeMap: Record<number, DisputeType> = {
    0: DisputeType.POI,
    1: DisputeType.QUERY,
  };

  if (type in typeMap) {
    return typeMap[type];
  } else {
    throw new Error(
      `Unexpected dispute type "${type}" provided to function getDisputeType`
    );
  }
}

function getDisputeState(state: number): DisputeState {
  const stateMap: Record<number, DisputeState> = {
    0: DisputeState.ONGOING,
    1: DisputeState.ACCEPTED,
    2: DisputeState.REJECTED,
    3: DisputeState.CANCELLED,
  };

  if (state in stateMap) {
    return stateMap[state];
  } else {
    throw new Error(
      `Unexpected dispute state "${state}" provided to function getDisputeState`
    );
  }
}

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
