// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

export interface CreateIndexerParams {
  address: string;
  metadata?: string;
  active?: boolean;
  createdBlock?: number;
  lastEvent?: string;
  controller?: string;
}
