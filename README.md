# SubQuery Query Registry Project

SubQuery project for indexing data for the [QueryRegistry](https://github.com/subquery/contracts/blob/main/contracts/QueryRegistry.sol) contract

## Building

- `yarn`
- `subql codegen`
- `yarn build`

## Running locally

The docker compose file has been updated to include a moonbeam development node

1. Spin up the environment `docker-compose up`
2. Deploy @subql/contract-sdk contracts `PLATFORM="moonbeam" ENDPOINT="http://127.0.0.1:9933" SEED="bottom drive obey lake curtain smoke basket hold race lonely fit walk" yarn deploy`
3. Update the project.yaml to include QueryRegistry address from previous step
4. Restart the environment. Cancel the docker task and run `docker-compose up` again. The chain state should persist and the indexer running the project with the correct address
