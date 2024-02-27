import { EthereumLog } from '@subql/types-ethereum';
import { BurnEvent } from '../types/contracts/L2SQToken';
import assert from 'assert';
import { Withdraw } from '../types';
import { biToDate } from './utils';

export async function handleBurn(event: EthereumLog<BurnEvent['args']>) {
  logger.info('handleBurn');
  assert(event.args, 'No event args');
  const { _account: account, _amount: amount } = event.args;

  await Withdraw.create({
    id: `${event.transactionHash}:${event.logIndex}`,
    txHash: event.transactionHash,
    sender: account,
    amount: amount.toBigInt(),
    createAt: biToDate(event.block.timestamp),
    blockheight: event.blockNumber,
  }).save();
}
