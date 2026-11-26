/**
 * Blockchain IQ LangChain tool — pay-per-call crypto market data over x402.
 *
 * One tool, one job: buy a single Blockchain IQ resource with USDC on Base
 * (x402 v2, settled by Coinbase's CDP facilitator — the payer pays no gas)
 * and return the JSON plus the on-chain settlement proof.
 *
 * Payment safety (all enforced before any signature is produced):
 * - Every HTTP 402 is intercepted by a guarded fetch and validated: the asset
 *   must be USDC on Base, the payTo must be Blockchain IQ's published
 *   address, and the amount must be within the per-call cap (default $0.05).
 *   Anything else throws and no payment happens. A 404 or any error
 *   response is never charged by the API.
 * - The guard sits inside the fetch that @x402/fetch itself calls, so the
 *   exact 402 terms that get paid are the ones that were validated — there
 *   is no separate probe request that could go stale.
 *
 * The private key is passed to createBlockchainIQTool() as an argument.
 * The demo script (src/demo.ts) reads it from the BLOCKCHAINIQ_PRIVATE_KEY
 * environment variable. Use a dedicated wallet with a small balance.
 * Never commit a key.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

export const BASE_URL = "https://www.blockchainiq.co/api/x402/v1";
export const NETWORK = "eip155:8453"; // Base
export const USDC_DECIMALS = 6;
export const USDC_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC on Base, verified on Basescan 2026-11-26 (FiatTokenProxy, 12.7M holders)
export const EXPECTED_PAYTO = "0x617da9383fba67e86137bc4924b8b7e400fb7c9e"; // Base USDC payTo from Blockchain IQ's public agent catalogue — the tool refuses to pay any other address

const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
const SLUG_PAIR = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i;

function slugArg(arg: string | undefined, fallback: string, what: string): string {
  const value = arg ?? fallback;
  if (!SLUG.test(value)) {
    throw new Error(`Invalid ${what} "${value}": expected a slug like "bitcoin-network"`);
  }
  return value;
}

function slugPairArg(arg: string | undefined, fallback: string): string {
  const value = arg ?? fallback;
  if (!SLUG_PAIR.test(value)) {
    throw new Error(
      `Invalid dashboard/panel "${value}": expected "slug/panel" like "bitcoin-network/active-addresses"`,
    );
  }
  return value;
}

/** Resource id -> API path. `arg` fills the slug, `days` the day range. */
const RESOURCE_PATHS: Record<string, (arg?: string, days?: number) => string> = {
  brief: () => "/brief",
  macro: () => "/macro",
  calendar: () => "/calendar",
  indices: () => "/indices",
  networks: () => "/networks",
  stablecoins: () => "/stablecoins",
  "x402-market": () => "/x402-market",
  "event-risk": (_arg, days) => {
    const d = days ?? 7;
    if (!Number.isInteger(d) || d < 1 || d > 90) {
      throw new Error(`Invalid days "${days}": expected an integer 1-90`);
    }
    return `/event-risk?days=${d}`;
  },
  network: (arg) => `/network/${slugArg(arg, "bitcoin-network", "chain slug")}`,
  dashboard: (arg) => `/dashboards/${slugArg(arg, "bitcoin-network", "dashboard slug")}`,
  "dashboard-panel": (arg) =>
    `/dashboards/${slugPairArg(arg, "bitcoin-network/active-addresses")}`,
  cardano: () => "/cardano",
};

export const RESOURCE_IDS = Object.keys(RESOURCE_PATHS);

export function resolvePath(resource: string, arg?: string, days?: number): string {
  const fn = RESOURCE_PATHS[resource];
  if (!fn) {
    throw new Error(
      `Unknown resource "${resource}". Valid resources: ${RESOURCE_IDS.join(", ")}`,
    );
  }
  return fn(arg, days);
}

type AcceptEntry = {
  network?: string;
  asset?: string;
  amount?: string | number;
  payTo?: string;
};

function maxAtomicForCap(maxUsdPerCall: number): bigint {
  if (!Number.isFinite(maxUsdPerCall) || maxUsdPerCall <= 0) {
    throw new Error(`maxUsdPerCall must be a finite number > 0, got ${maxUsdPerCall}`);
  }
  return parseUnits(String(maxUsdPerCall), USDC_DECIMALS);
}

/**
 * Validate a PAYMENT-REQUIRED header (base64 JSON). Throws unless EVERY
 * Base entry in it is USDC, payable to Blockchain IQ's published address,
 * and within the per-call cap. Returns the highest Base price in USD.
 */
export function validatePaymentRequirements(header: string, maxUsdPerCall: number): number {
  const maxAtomic = maxAtomicForCap(maxUsdPerCall);
  let req: { accepts?: AcceptEntry[] };
  try {
    req = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts?: AcceptEntry[];
    };
  } catch {
    throw new Error("PAYMENT-REQUIRED header is not valid base64 JSON");
  }
  const baseEntries = (req.accepts ?? []).filter((a) => a.network === NETWORK);
  if (baseEntries.length === 0) {
    throw new Error(`No payment option for ${NETWORK} in PAYMENT-REQUIRED header`);
  }
  let maxPrice = 0;
  for (const entry of baseEntries) {
    if ((entry.asset ?? "").toLowerCase() !== USDC_ASSET.toLowerCase()) {
      throw new Error(`Refusing to pay: asset ${entry.asset} is not USDC on Base`);
    }
    if ((entry.payTo ?? "").toLowerCase() !== EXPECTED_PAYTO.toLowerCase()) {
      throw new Error(
        `Refusing to pay: payTo ${entry.payTo} is not the expected Blockchain IQ address ${EXPECTED_PAYTO}`,
      );
    }
    let amount: bigint;
    try {
      amount = BigInt(entry.amount ?? "");
    } catch {
      throw new Error(`Refusing to pay: invalid amount ${entry.amount}`);
    }
    if (amount < 0n) throw new Error("Refusing to pay: negative amount");
    if (amount > maxAtomic) {
      throw new Error(
        `Refusing to pay: amount exceeds the $${maxUsdPerCall} per-call cap`,
      );
    }
    const price = Number(formatUnits(amount, USDC_DECIMALS));
    if (price > maxPrice) maxPrice = price;
  }
  return maxPrice;
}

/**
 * A fetch wrapper that validates every HTTP 402 BEFORE @x402/fetch pays it.
 * - Free resources (200) pass through untouched, no payment.
 * - Paid resources: the 402 header is validated (USDC on Base, expected
 *   payTo, within the cap) inside the same fetch @x402/fetch calls, so the
 *   terms that get paid are exactly the terms that were checked.
 * - The actual payment goes through @x402/fetch (ExactEvmScheme, Base).
 */
export function createPaidFetch(privateKey: `0x${string}`, maxUsdPerCall = 0.05) {
  maxAtomicForCap(maxUsdPerCall); // fail fast on a bad cap
  const account = privateKeyToAccount(privateKey);
  const guardedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const res = await fetch(input, { ...init, redirect: "error" });
    if (res.status !== 402) return res;
    const header = res.headers.get("payment-required");
    if (!header) throw new Error("HTTP 402 without a PAYMENT-REQUIRED header");
    validatePaymentRequirements(header, maxUsdPerCall);
    return res;
  };
  return wrapFetchWithPaymentFromConfig(guardedFetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
  });
}

/** Decode the PAYMENT-RESPONSE header into the settlement proof. */
export function settlementFromHeader(header: string | null): unknown {
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    try {
      return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      return header;
    }
  }
}

/** Build the `blockchain_iq` LangChain tool. */
export function createBlockchainIQTool(
  privateKey: `0x${string}`,
  opts?: { maxUsdPerCall?: number },
) {
  const maxUsdPerCall = opts?.maxUsdPerCall ?? 0.05;
  const fetchWithCap = createPaidFetch(privateKey, maxUsdPerCall);

  return tool(
    async ({ resource, arg, days }) => {
      const path = resolvePath(resource, arg, days);
      const url = `${BASE_URL}${path}`;
      const res = await fetchWithCap(url);
      if (!res.ok) {
        const text = await res.text();
        return JSON.stringify({
          ok: false,
          resource,
          path,
          status: res.status,
          error: text.slice(0, 500),
        });
      }
      const settlement = settlementFromHeader(res.headers.get("payment-response"));
      const data = await res.json();
      // Settlement first so it survives truncation of very large payloads.
      const out = JSON.stringify({ ok: true, resource, path, settlement, data });
      const LIMIT = 12000;
      return out.length > LIMIT
        ? out.slice(0, LIMIT) + ` ... [truncated, ${out.length} chars total]`
        : out;
    },
    {
      name: "blockchain_iq",
      description: [
        "Buy one crypto market-data resource from Blockchain IQ, paid per call in USDC on Base via x402.",
        "No account or API key. The cheapest resource is the market brief ($0.01).",
        `Every call is capped: the tool refuses to pay more than $${maxUsdPerCall} in a single call.`,
        "Returns JSON with the data plus the on-chain settlement proof (transaction hash).",
        `Valid resources: ${RESOURCE_IDS.join(", ")}.`,
        "Use resource=brief with no arguments for the $0.01 market brief.",
      ].join(" "),
      schema: z.object({
        resource: z
          .string()
          .default("brief")
          .describe(
            `Resource id to buy (${RESOURCE_IDS.join(", ")}). Defaults to "brief" when the agent just needs the current market picture.`,
          ),
        arg: z
          .string()
          .optional()
          .describe(
            "Slug argument for parameterized resources: chain slug for network (e.g. bitcoin-network, solana-network), dashboard slug for dashboard, or 'slug/panel' for dashboard-panel (e.g. bitcoin-network/active-addresses).",
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Day range for event-risk (1-90, default 7)."),
      }),
    },
  );
}
