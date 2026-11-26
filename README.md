# Blockchain IQ — LangChain tool

A LangChain tool that buys crypto market data from [Blockchain IQ](https://www.blockchainiq.co/agents)
one call at a time, paid in USDC on Base via the open [x402](https://www.x402.org/) standard.
No account, no API key.

Built for the [Blockchain IQ agent-framework bounty](https://www.blockchainiq.co/blog/x402-build-bounties)
($525 total: $150 for the first qualifying integration, $125 for the next three;
round closes 31 December 2026).

## What it does

- `blockchain_iq` tool: buy one resource (`brief`, `macro`, `calendar`, `indices`,
  `networks`, `stablecoins`, `x402-market`, `event-risk`, `network`, `dashboard`,
  `dashboard-panel`, `cardano`). Default resource is the market brief — **$0.01**, parameter-free.
- Every call is pre-flighted: the tool reads the HTTP 402 price first and refuses to
  pay more than **$0.05 per call**. A 404 or error response is never charged.
- Returns the data plus the on-chain settlement proof (transaction hash from the
  `PAYMENT-RESPONSE` header, verifiable on Basescan).
- The payer pays no gas: settlement goes through Coinbase's CDP facilitator.

## Install

```bash
npm install
npm run build
```

## Test without paying

```bash
npm run free-test
```

Fetches the free catalogue (checks `/brief` costs $0.01) and the free sample, no wallet needed.

## Demo the paid call ($0.01)

```bash
BLOCKCHAINIQ_PRIVATE_KEY=0x... npm run demo
```

Buys `/brief` through the tool and prints the settlement transaction hash.
The key must belong to a wallet holding a little USDC on Base. Only $0.01 is spent.

## Use the tool directly

```ts
import { createBlockchainIQTool } from "./dist/tool.js";

const tool = createBlockchainIQTool(process.env.BLOCKCHAINIQ_PRIVATE_KEY as `0x${string}`);
await tool.invoke({ resource: "brief" });
```

To use it inside an agent, bind it to any LangChain chat model with
`.bindTools([tool])` — the model can then call `blockchain_iq` by name.

## Verified paid call

`npm run demo` buys `/brief` for $0.01 and prints the settlement proof:

- Transaction: https://basescan.org/tx/0x309569ea5bffee4519f2fbe61469daa74f8cc5b12be48994ae2b75197bb1ad4d
- Payer: `0xD213A04DdBD11bA3f8Ce6E8dce935FCCaA324d86` (Base, eip155:8453)

Requires Node.js 18+ (built-in `fetch`).

## Security

- The demo reads the private key from the `BLOCKCHAINIQ_PRIVATE_KEY` environment
  variable; the library function `createBlockchainIQTool()` takes the key as an
  argument instead.
- Use a dedicated wallet with a small balance. Keys are never committed — see `.gitignore`.
- The tool never pays more than the per-call cap, and only pays the `payTo` address
  published in Blockchain IQ's public agent catalogue; any other address, asset,
  or an amount over the cap is refused before anything is signed.
- The per-call cap does not limit total spend across repeated calls — that is why
  the wallet should hold only a small balance.
