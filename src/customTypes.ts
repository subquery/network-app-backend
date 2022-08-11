// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { BigNumber } from '@ethersproject/bignumber';
import { AcalaEvmEvent } from '@subql/acala-evm-processor';

export interface WithdrawlParams {
  id: string;
  delegator: string;
  indexer: string;
  index: BigNumber;
  amount: BigNumber;
  claimed: boolean;
  event: AcalaEvmEvent;
}
