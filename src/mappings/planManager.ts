// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  PlanCreatedEvent,
  PlanRemovedEvent,
  PlanTemplateCreatedEvent,
  PlanTemplateMetadataChangedEvent,
  PlanTemplateStatusChangedEvent,
} from '@subql/contract-sdk/typechain/PlanManager';

import { PlanManager__factory } from '@subql/contract-sdk';
import { PlanTemplateV2Struct } from '@subql/contract-sdk/typechain/interfaces/IPlanManager';
import { EthereumLog } from '@subql/types-ethereum';
import assert from 'assert';
import { BigNumber, constants } from 'ethers';
import { Plan, PlanTemplate } from '../types';
import { Contracts, bytesToIpfsCid, getContractAddress } from './utils';

export async function handlePlanTemplateCreated(
  event: EthereumLog<PlanTemplateCreatedEvent['args']>
): Promise<void> {
  logger.info('handlePlanTemplateCreated');
  assert(event.args, 'No event args');

  const network = await api.getNetwork();

  let rawPlanTemplate: PlanTemplateV2Struct;
  const planManagerAddress = getContractAddress(
    network.chainId,
    Contracts.PLAN_MANAGER_ADDRESS
  );

  const planManager = PlanManager__factory.connect(planManagerAddress, api);
  rawPlanTemplate = await planManager.getPlanTemplate(event.args.templateId);

  const planTemplate = PlanTemplate.create({
    id: event.args.templateId.toHexString(),
    period: BigNumber.from(rawPlanTemplate.period).toBigInt(),
    dailyReqCap: BigNumber.from(rawPlanTemplate.dailyReqCap).toBigInt(),
    rateLimit: BigNumber.from(rawPlanTemplate.rateLimit).toBigInt(),
    priceToken: rawPlanTemplate.priceToken,
    metadata:
      constants.HashZero === rawPlanTemplate.metadata
        ? undefined
        : bytesToIpfsCid(rawPlanTemplate.metadata.toString()),
    active: true,
    createdBlock: event.blockNumber,
  });

  await planTemplate.save();
}

export async function handlePlanTemplateMetadataUpdated(
  event: EthereumLog<PlanTemplateMetadataChangedEvent['args']>
): Promise<void> {
  logger.info('handlePlanTemplateMetadataUpdated');
  assert(event.args, 'No event args');

  const id = event.args.templateId.toHexString();

  const planTemplate = await PlanTemplate.get(id);
  assert(planTemplate, `Plan template not found. templateId="${id}"`);
  planTemplate.metadata = bytesToIpfsCid(event.args.metadata);
  planTemplate.lastEvent = `handlePlanTemplateMetadataUpdated:${event.blockNumber}`;

  await planTemplate.save();
}

export async function handlePlanTemplateStatusUpdated(
  event: EthereumLog<PlanTemplateStatusChangedEvent['args']>
): Promise<void> {
  logger.info('handlePlanTemplateStatusUpdated');
  assert(event.args, 'No event args');

  const id = event.args.templateId.toHexString();
  const planTemplate = await PlanTemplate.get(id);
  assert(planTemplate, `Plan template not found. templateId="${id}"`);

  planTemplate.active = event.args.active;
  planTemplate.lastEvent = `handlePlanTemplateStatusUpdated:${event.blockNumber}`;

  await planTemplate.save();
}

export async function handlePlanCreated(
  event: EthereumLog<PlanCreatedEvent['args']>
): Promise<void> {
  assert(event.args, 'No event args');
  logger.info(`handlePlanCreated: ${event.args.planId.toHexString()}`);

  const plan = Plan.create({
    id: event.args.planId.toHexString(),
    planTemplateId: event.args.planTemplateId.toHexString(),
    creator: event.args.creator,
    price: event.args.price.toBigInt(),
    active: true,
    deploymentId:
      constants.HashZero === event.args.deploymentId
        ? undefined
        : bytesToIpfsCid(event.args.deploymentId),
    createdBlock: event.blockNumber,
  });

  await plan.save();
}

export async function handlePlanRemoved(
  event: EthereumLog<PlanRemovedEvent['args']>
): Promise<void> {
  logger.info('handlePlanRemoved');
  assert(event.args, 'No event args');
  const planId = event.args.planId.toHexString();
  const plan = await Plan.get(planId);

  assert(plan, `Plan not found. planId="${planId}"`);

  plan.active = false;
  plan.lastEvent = `handlePlanRemoved:${event.blockNumber}`;

  await plan.save();
}
