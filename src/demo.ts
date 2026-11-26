/**
 * Demo: buy the $0.01 market brief through the LangChain tool and print
 * the settlement proof. This is the paid call the bounty requires.
 *
 *   BLOCKCHAINIQ_PRIVATE_KEY=0x... npm run demo
 *
 * The key must belong to a wallet holding a little USDC on Base.
 * Only $0.01 is spent; the tool refuses any call over $0.05.
 */
import { createBlockchainIQTool } from "./tool.js";

const key = process.env.BLOCKCHAINIQ_PRIVATE_KEY as `0x${string}` | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(
    "Set BLOCKCHAINIQ_PRIVATE_KEY=0x... (64 hex chars; dedicated wallet, small USDC balance on Base).",
  );
  process.exit(1);
}

const tool = createBlockchainIQTool(key, { maxUsdPerCall: 0.05 });
console.log("Buying /brief through the blockchain_iq tool...");
const result = await tool.invoke({ resource: "brief" });
const parsed = JSON.parse(result) as {
  ok: boolean;
  resource: string;
  settlement?: { transaction?: string; network?: string; payer?: string };
  data?: unknown;
  status?: number;
  error?: string;
};

console.log(JSON.stringify({ ok: parsed.ok, resource: parsed.resource, settlement: parsed.settlement }, null, 2));
const tx = parsed.settlement?.transaction;
if (tx) console.log("Proof on Basescan: https://basescan.org/tx/" + tx);
if (!parsed.ok) {
  console.log("Error:", parsed.status, parsed.error);
  process.exit(1);
}
console.log("Data (first 2000 chars):");
console.log(JSON.stringify(parsed.data, null, 2).slice(0, 2000));
