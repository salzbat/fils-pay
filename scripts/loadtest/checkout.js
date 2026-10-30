// Checkout capacity test (docs/CAPACITY.md). k6, through the TLS proxy, as a
// buyer would: the merchant creates a single-use payment link, the buyer
// opens the hosted checkout page, loads the link and pays with a card.
//
//   docker run --rm --network host -v "$PWD/scripts/loadtest:/s" \
//     -e BASE=https://localhost -e MERCHANT_ID=... -e API_KEY=... \
//     -e PROFILE=ramp grafana/k6 run /s/checkout.js
//
// PROFILE=ramp     find the knee: 5 -> 130 concurrent buyers in steps
// PROFILE=steady   hold VUS buyers for DURATION (default 20 x 3m)
// PROFILE=overload push far past the knee (200 VUs) to check shedding/recovery
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "https://localhost";
const MERCHANT_ID = __ENV.MERCHANT_ID;
const API_KEY = __ENV.API_KEY;
const PROFILE = __ENV.PROFILE || "ramp";

const profiles = {
  ramp: {
    executor: "ramping-vus",
    startVUs: 5,
    stages: [5, 10, 20, 40, 60, 80, 100, 130].flatMap((v) => [
      { duration: "10s", target: v },
      { duration: "50s", target: v },
    ]),
  },
  steady: { executor: "constant-vus", vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || "3m" },
  overload: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: "20s", target: 200 },
      { duration: "2m", target: 200 },
      { duration: "10s", target: 0 },
    ],
  },
};

export const options = {
  insecureSkipTLSVerify: true, // self-signed cert on a local run
  scenarios: { checkout: profiles[PROFILE] },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

const checkoutOk = new Rate("checkout_ok");
const checkoutDuration = new Trend("checkout_duration", true);
const shed = new Counter("shed_503_429");
const declined = new Counter("card_declined_402");
const acquirerDown = new Counter("acquirer_unavailable_502");
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

// Seconds a buyer spends on the checkout page before paying. A turned-away
// buyer waits Retry-After (1 s) before starting again, like a real client.
const THINK = Number(__ENV.THINK || 1);
function backOff() {
  shed.add(1);
  sleep(1);
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  const t0 = Date.now();
  const create = http.post(
    `${BASE}/v1/merchants/${MERCHANT_ID}/payment-links`,
    JSON.stringify({ amountFils: 12_345, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    { headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, tags: { step: "create_link" } },
  );
  if (create.status === 503 || create.status === 429) return backOff();
  if (!check(create, { "link created": (r) => r.status === 201 })) return void checkoutOk.add(false);
  const token = create.json("token");

  http.get(`${BASE}/pay/${token}`, { tags: { step: "checkout_page" } });
  sleep(THINK); // the buyer reads the page and types their card
  const link = http.get(`${BASE}/v1/payment-links/${token}`, { tags: { step: "load_link" } });
  if (link.status === 503 || link.status === 429) return backOff();

  const pay = http.post(`${BASE}/v1/payment-links/${token}/pay`, JSON.stringify({ card: CARD }), {
    headers: { "content-type": "application/json", "idempotency-key": uuid() },
    tags: { step: "pay" },
  });
  if (pay.status === 503 || pay.status === 429) return backOff();
  // The acquirer simulator fails ~2% of calls on purpose (ACQUIRER_FAILURE_RATE):
  // a decline is 402, an acquirer outage 502. Both are correct answers.
  if (pay.status === 402) declined.add(1);
  if (pay.status === 502) acquirerDown.add(1);
  const ok = check(pay, { "paid, declined or acquirer down": (r) => [200, 402, 502].includes(r.status) });
  checkoutOk.add(ok);
  if (ok) checkoutDuration.add(Date.now() - t0 - THINK * 1000);
}
