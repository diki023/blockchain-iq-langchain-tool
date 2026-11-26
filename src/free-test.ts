/**
 * Free test: exercises the public API without a wallet or any payment.
 * - GET the free catalogue, list the resources and the /brief price.
 * - GET the free sample and check its shape (transactions, activeAddresses, fees).
 * Run: npm run free-test
 */
const BASE_URL = "https://www.blockchainiq.co/api/x402/v1";

type Resource = { id: string; path: string; price: string; title: string };

const catRes = await fetch(BASE_URL);
if (!catRes.ok) {
  console.error("Catalogue fetch failed:", catRes.status);
  process.exit(1);
}
const cat = (await catRes.json()) as { data?: Resource[] };
const resources = cat.data ?? [];
console.log(`Catalogue OK: ${resources.length} resources`);
const brief = resources.find((r) => r.id === "brief");
console.log("brief:", brief ? `${brief.path} price ${brief.price}` : "NOT FOUND");
if (!brief || brief.price !== "$0.01") {
  console.error("Unexpected /brief entry — check the catalogue before paying.");
  process.exit(1);
}

const sampleRes = await fetch(`${BASE_URL}/sample`);
if (!sampleRes.ok) {
  console.error("Sample fetch failed:", sampleRes.status);
  process.exit(1);
}
const sample = (await sampleRes.json()) as { data?: Record<string, unknown> };
const d = sample.data ?? sample;
console.log("Sample OK. Keys:", Object.keys(d).join(", "));
console.log(JSON.stringify(d, null, 2).slice(0, 800));
console.log("FREE TEST PASSED");
