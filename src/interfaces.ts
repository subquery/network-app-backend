// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { BigNumber } from '@ethersproject/bignumber';
import { EthereumLog } from '@subql/types-ethereum';
import { ServiceStatus, WithdrawalStatus } from './types';
import { WithdrawalType } from './types/enums';

export interface CreateWithdrawlParams {
  id: string;
  delegator: string;
  indexer: string;
  index: BigNumber;
  amount: BigNumber;
  status: WithdrawalStatus;
  type: WithdrawalType;
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

export interface ISaveIndexerDeployment {
  indexerId: string;
  deploymentId: string;
  blockHeight?: bigint;
  timestamp?: Date;
  mmrRoot?: string;
  status: ServiceStatus;
  lastEvent?: string;
}
