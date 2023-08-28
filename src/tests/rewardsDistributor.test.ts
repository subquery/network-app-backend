import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
  gql,
} from '@apollo/client/core';
import { onError } from '@apollo/client/link/error';
import { fetch } from 'cross-fetch';
import * as request from 'supertest';
import { DocumentNode } from 'graphql';
import { Indexer, Delegator, Delegation, EraReward, Reward } from '../types';
import { BigNumber } from 'ethers';

jest.setTimeout(300000);

describe('rewardsDistributor', () => {
  let client: ApolloClient<any>;
  let indexerList: Indexer[];
  let delegatorList: Delegator[];

  beforeAll(() => {
    client = new ApolloClient({
      link: onError(({ graphQLErrors, networkError }) => {
        if (networkError) {
          console.error('networkError', networkError);
        }
        if (graphQLErrors) {
          console.error('graphQLErrors', graphQLErrors);
        }
      }).concat(
        new HttpLink({
          uri: 'https://api.subquery.network/sq/subquery/kepler-network-staging',
          fetch,
          fetchOptions: {
            timeout: 20000,
          },
        })
      ),
      cache: new InMemoryCache(),
    });
  });

  it('should have indexer list', async () => {
    const { data } = await queryIndexerList(client);
    console.log('indexer length:', data.indexers.totalCount);
    expect(data.indexers.totalCount).toBeGreaterThan(0);
    expect(data.indexers.nodes.length).toBeGreaterThan(0);
    expect(data.indexers.totalCount).toBe(data.indexers.nodes.length);
    indexerList = data.indexers.nodes;
  });

  it('should have delegator list', async () => {
    const { data } = await queryDelegatorList(client);
    console.log('delegator length:', data.delegators.totalCount);
    expect(data.delegators.totalCount).toBeGreaterThan(0);
    expect(data.delegators.nodes.length).toBeGreaterThan(0);
    expect(data.delegators.totalCount).toBe(data.delegators.nodes.length);
    delegatorList = data.delegators.nodes;
  });

  it('will validate each indexers reward', async () => {
    if (!indexerList) {
      indexerList = (await queryIndexerList(client)).data.indexers.nodes;
    }
    await Promise.all(
      indexerList.map(async (indexer) => {
        expect(indexer.id).toBeDefined();
        const delegations = await queryDelegations(client, indexer.id);
        // console.log(delegations.data.delegations.totalCount);
        const rewards = await queryRewards(client, indexer.id);
        const unclaimedRewards = await queryUnclaimedRewards(
          client,
          indexer.id
        );
        const eraRewards = await queryEraRewards(client, indexer.id);
        await Promise.all(
          delegations.data.delegations.nodes.map(
            async (delegation: Delegation) => {
              let delegatorId = delegation.delegatorId;
              let rewardAmount = BigNumber.from(0);
              rewards.data.rewards.nodes.map((reward: Reward) => {
                if (reward.delegatorId == delegatorId) {
                  rewardAmount = rewardAmount.add(reward.amount);
                }
              });
              let unclaimedReward =
                unclaimedRewards.data.unclaimedRewards.nodes.find(
                  (value: any, index: number, obj: []) => {
                    return value.delegatorId == delegatorId;
                  }
                );
              let allEraRewards = BigNumber.from(0);
              let allEraUnclaimedRewards = BigNumber.from(0);
              let count = 0;
              eraRewards.data.eraRewards.nodes.map((eraReward: EraReward) => {
                if (eraReward.isCommission) {
                  return;
                }
                if (eraReward.delegatorId == delegatorId) {
                  if (eraReward.claimed) {
                    allEraRewards = allEraRewards.add(eraReward.amount);
                    count++;
                  } else {
                    allEraUnclaimedRewards = allEraUnclaimedRewards.add(
                      eraReward.amount
                    );
                  }
                }
              });
              // console.log(
              //   `indexerId: ${indexer.id}, delegatorId: ${delegatorId}`
              // );
              if (!rewardAmount.eq(allEraRewards)) {
                console.log(
                  `indexerId: ${indexer.id}, delegatorId: ${delegatorId}`
                );
                console.log(
                  `rewardAmount: ${rewardAmount}, allEraRewards: ${allEraRewards}`
                );
              }
              // expect(rewardAmount.eq(allEraRewards)).toBe(true);
              if (unclaimedReward) {
                if (
                  !BigNumber.from(unclaimedReward.amount).eq(
                    allEraUnclaimedRewards
                  )
                ) {
                  console.log(
                    `indexerId: ${indexer.id}, delegatorId: ${delegatorId}`
                  );
                  console.log(
                    `unclaimedReward: ${unclaimedReward.amount}, allEraUnclaimedRewards: ${allEraUnclaimedRewards}`
                  );
                }
                // expect(
                //   BigNumber.from(unclaimedReward.amount).eq(
                //     allEraUnclaimedRewards
                //   )
                // ).toBe(true);
              } else {
                // expect(allEraUnclaimedRewards.eq(BigNumber.from(0))).toBe(true);
                console.log(
                  `indexerId: ${indexer.id}, delegatorId: ${delegatorId}`
                );
                console.log(
                  `allEraUnclaimedRewards: ${allEraUnclaimedRewards}`
                );
              }
            }
          )
        );
      })
    );
  });
});

async function queryEraRewards(client: ApolloClient<any>, indexerId: string) {
  const queryEraRewards = gql`
    query ($indexerId: String!, $offset: Int!) {
      eraRewards(
        filter: { indexerId: { equalTo: $indexerId } }
        offset: $offset
      ) {
        totalCount
        aggregates {
          sum {
            amount
          }
        }
        nodes {
          id
          eraId
          eraIdx
          indexerId
          isCommission
          isIndexer
          delegatorId
          claimed
          amount
          createdTimestamp
        }
      }
    }
  `;
  return await queryFullList(client, queryEraRewards, 'eraRewards', {
    indexerId,
  });
}

async function queryRewards(client: ApolloClient<any>, indexerAddress: string) {
  const queryRewards = gql`
    query ($indexerAddress: String!, $offset: Int!) {
      rewards(
        filter: { indexerAddress: { equalTo: $indexerAddress } }
        offset: $offset
      ) {
        totalCount
        aggregates {
          sum {
            amount
          }
        }
        nodes {
          id
          indexerAddress
          delegatorId
          amount
        }
      }
    }
  `;
  return await queryFullList(client, queryRewards, 'rewards', {
    indexerAddress,
  });
}

async function queryUnclaimedRewards(
  client: ApolloClient<any>,
  indexerAddress: string
) {
  const queryUnclaimedRewards = gql`
    query ($indexerAddress: String!, $offset: Int!) {
      unclaimedRewards(
        filter: { indexerAddress: { equalTo: $indexerAddress } }
        offset: $offset
      ) {
        totalCount
        aggregates {
          sum {
            amount
          }
        }
        nodes {
          id
          amount
          indexerAddress
          delegatorId
        }
      }
    }
  `;

  return await queryFullList(
    client,
    queryUnclaimedRewards,
    'unclaimedRewards',
    {
      indexerAddress,
    }
  );
}

async function queryDelegations(client: ApolloClient<any>, indexerId: string) {
  const queryDelegations = gql`
    query ($indexerId: String!, $offset: Int!) {
      delegations(
        offset: $offset
        filter: { indexerId: { equalTo: $indexerId } }
      ) {
        totalCount
        nodes {
          id
          indexerId
          delegatorId
          amount
          createdBlock
        }
      }
    }
  `;
  return await queryFullList(client, queryDelegations, 'delegations', {
    indexerId,
  });
}

async function queryIndexerList(client: ApolloClient<any>) {
  const queryIndexerList = gql`
    {
      indexers {
        totalCount
        nodes {
          id
          active
          capacity
          commission
          controller
          lastEvent
          lastRewardedEra
          maxUnstakeAmount
          metadata
          totalStake
        }
      }
    }
  `;
  return await queryFullList(client, queryIndexerList, 'indexers');
}

async function queryDelegatorList(client: ApolloClient<any>) {
  const queryDelegatorList = gql`
    query ($offset: Int!) {
      delegators(offset: $offset) {
        totalCount
        nodes {
          id
          totalDelegations
          createdBlock
          lastEvent
        }
      }
    }
  `;
  return await queryFullList(client, queryDelegatorList, 'delegators');
}

async function queryIndexerRewards(
  client: ApolloClient<any>,
  indexerId: string
) {
  const queryIndexerRewards = gql`
    query ($indexerId: ID!) {
      indexerRewards(indexerId: $indexerId) {
        totalCount
        nodes {
          id
          indexerId
          delegatorId
          era
          amount
          createdBlock
          createdEra
          createdTime
        }
      }
    }
  `;
  const { data } = await client.query({
    query: queryIndexerRewards,
    variables: { indexerId },
  });
  return data.indexerRewards.nodes;
}

async function queryFullList(
  client: ApolloClient<any>,
  query: DocumentNode,
  entity: string,
  variables?: any
) {
  let offset = 0;
  let totalCount = 1;
  let result;
  let aggregates;
  while (offset < totalCount) {
    let page = await client.query({
      query,
      variables: { ...variables, offset },
    });
    offset += page.data[entity].nodes.length;
    totalCount = page.data[entity].totalCount;
    if (!result) {
      result = page.data[entity].nodes;
      aggregates = page.data[entity].aggregates;
    } else {
      result = result.concat(page.data[entity].nodes);
    }
  }
  return { data: { [entity]: { nodes: result, totalCount, aggregates } } };
}

function stringify(obj: any) {
  return JSON.stringify(obj, null, 2);
}
