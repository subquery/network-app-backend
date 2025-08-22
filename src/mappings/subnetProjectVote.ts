import assert from 'assert';
import { ProjectVote, ProjectVoteActivity, VoteActivityType } from '../types';
import {
  VotedLog,
  WithdrawnLog,
} from '../types/abi-interfaces/SubnetProjectVote';
import { biToDate } from './utils';

export async function handleVoted(event: VotedLog) {
  logger.info('handleVoted');
  assert(event.args, 'No event args');

  const { user, projectId, amount } = event.args;
  const timestamp = biToDate(event.block.timestamp);

  // Create ProjectVoteActivity record
  await ProjectVoteActivity.create({
    id: `${event.transactionHash}:${event.logIndex}`,
    user,
    projectId,
    activityType: VoteActivityType.VOTE,
    amount: amount.toBigInt(),
    timestamp,
    blockHeight: event.blockNumber,
    transactionHash: event.transactionHash,
    createdBlock: event.blockNumber,
    lastEvent: `handleVoted:${event.blockNumber}`,
  }).save();

  // Update or create ProjectVote record
  const voteId = `${user}:${projectId}`;
  let projectVote = await ProjectVote.get(voteId);

  if (!projectVote) {
    // Create new ProjectVote record
    projectVote = ProjectVote.create({
      id: voteId,
      user,
      projectId,
      totalVoted: amount.toBigInt(),
      totalWithdrawn: BigInt(0),
      currentBalance: amount.toBigInt(),
      firstVotedAt: timestamp,
      lastVotedAt: timestamp,
      lastWithdrawnAt: undefined,
      createdBlock: event.blockNumber,
      lastEvent: `handleVoted:${event.blockNumber}`,
    });
  } else {
    // Update existing ProjectVote record
    projectVote.totalVoted = projectVote.totalVoted + amount.toBigInt();
    projectVote.currentBalance =
      projectVote.totalVoted - projectVote.totalWithdrawn;
    projectVote.lastVotedAt = timestamp;
    projectVote.lastEvent = `handleVoted:${event.blockNumber}`;
  }

  await projectVote.save();
}

export async function handleWithdrawn(event: WithdrawnLog) {
  logger.info('handleWithdrawn');
  assert(event.args, 'No event args');

  const { user, projectId, amount } = event.args;
  const timestamp = biToDate(event.block.timestamp);

  // Create ProjectVoteActivity record
  await ProjectVoteActivity.create({
    id: `${event.transactionHash}:${event.logIndex}`,
    user,
    projectId,
    activityType: VoteActivityType.WITHDRAW,
    amount: amount.toBigInt(),
    timestamp,
    blockHeight: event.blockNumber,
    transactionHash: event.transactionHash,
    createdBlock: event.blockNumber,
    lastEvent: `handleWithdrawn:${event.blockNumber}`,
  }).save();

  // Update ProjectVote record
  const voteId = `${user}:${projectId}`;
  const projectVote = await ProjectVote.get(voteId);

  if (projectVote) {
    projectVote.totalWithdrawn = projectVote.totalWithdrawn + amount.toBigInt();
    projectVote.currentBalance =
      projectVote.totalVoted - projectVote.totalWithdrawn;
    projectVote.lastWithdrawnAt = timestamp;
    projectVote.lastEvent = `handleWithdrawn:${event.blockNumber}`;

    await projectVote.save();
  } else {
    logger.warn(`ProjectVote not found for withdrawal: ${voteId}`);
  }
}
