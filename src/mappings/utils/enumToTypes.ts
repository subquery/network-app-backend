// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { DisputeType, DisputeState, WithdrawalType } from '../../types';

const disputeTypes = [DisputeType.POI, DisputeType.QUERY];
const disputeStates = [
  DisputeState.ONGOING,
  DisputeState.ACCEPTED,
  DisputeState.REJECTED,
  DisputeState.CANCELLED,
];
const withdrawalTypes = [
  WithdrawalType.UNDELEGATION,
  WithdrawalType.UNSTAKE,
  WithdrawalType.COMMISSION,
  WithdrawalType.MERGE,
];

export function getWithdrawalType(type: number): WithdrawalType {
  if (type < withdrawalTypes.length) {
    return withdrawalTypes[type];
  } else {
    throw new Error(
      `Unexpected withdrawal type "${type}" provided to function getWithdrawalType`
    );
  }
}

export function getDisputeType(type: number): DisputeType {
  if (type < disputeTypes.length) {
    return disputeTypes[type];
  } else {
    throw new Error(
      `Unexpected dispute type "${type}" provided to function getDisputeType`
    );
  }
}

export function getDisputeState(state: number): DisputeState {
  if (state < disputeStates.length) {
    return disputeStates[state];
  } else {
    throw new Error(
      `Unexpected dispute state "${state}" provided to function getDisputeState`
    );
  }
}
