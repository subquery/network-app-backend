# Subquery Network Subql Project

Subql project for indexing data for Subquery Network (Moonbase Alpha Testnet)

## Building

For `Testnet`:

- `yarn`
- `yarn codegen:testnet`
- `yarn build:testnet`
- `yarn deploy:testnet`

For `Kepler`

- `yarn codegen:kepler`
- `yarn build:kepler`
- `yarn deploy:kepler`

## Deploy Project to IPFS

```
- export SUBQL_ACCESS_TOKEN=ODPPNzPPNA==PP36I3Vw97rWozbzkmTt     (replace with your own token)
- yarn deploy:testnet or yarn deploy:kepler
```

## Running locally

`docker-compose up`
