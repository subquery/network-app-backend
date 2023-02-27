// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { BigNumber } from '@ethersproject/bignumber';
import { EthereumLog } from '@subql/types-ethereum';
import { Status, WithdrawalStatus } from './types';

export interface CreateWithdrawlParams {
  id: string;
  delegator: string;
  indexer: string;
  index: BigNumber;
  amount: BigNumber;
  status: WithdrawalStatus;
  event: EthereumLog;
}

export interface CreateIndexerParams {
  address: string;
  metadata?: string;
  active?: boolean;
  createdBlock?: number;
  lastEvent?: string;
  controller?: string;
}

export interface ISaveDeploymentIndexer {
  indexerId: string;
  deploymentId: string;
  blockHeight?: bigint;
  timestamp?: Date;
  mmrRoot?: string;
  status: Status;
  lastEvent?: string;
}
