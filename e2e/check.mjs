// End-to-end check across both projects. Plain Node 22+, no dependencies.
//   1. Subscribe the receiver to appointment.* on WebhookRelay (admin key).
//   2. Book an appointment on SchedulingApi as a seeded customer.
//   3. Expect the receiver to get appointment.created, signed with the subscription's secret.
//   4. Cancel it and expect appointment.cancelled.
import { createHmac, timingSafeEqual } from 'node:crypto';

const RELAY = process.env.RELAY_URL ?? 'http://localhost:3100';
const SCHEDULING = process.env.SCHEDULING_URL ?? 'http://localhost:8180';
const RECEIVER = process.env.RECEIVER_URL ?? 'http://localhost:4100';
const ADMIN_KEY = 'e2e-admin-key-0123456789abcdefghijklmnop';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(url, { method = 'GET', token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(what, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1000);
  }
}

/** What any receiver does: the docs/webhook-signature.md recipe, written independently here. */
function verifySignature(secret, headers, body) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return headers['webhook-signature'].split(' ').some((part) => {
    const received = Buffer.from(part.slice(3), 'base64');
    return (
      part.startsWith('v1,') &&
      received.length === expected.length &&
      timingSafeEqual(received, expected)
    );
  });
}

function step(message) {
  console.log(`- ${message}`);
}

// SchedulingApi's /health answers plain text ("Healthy"), so only the status code matters.
await waitFor('SchedulingApi', () => fetch(`${SCHEDULING}/health`).then((response) => response.ok));
step('both services are up');

const subscription = await call(`${RELAY}/subscriptions`, {
  method: 'POST',
  token: ADMIN_KEY,
  body: {
    name: 'e2e receiver',
    channel: 'webhook',
    target: 'http://receiver:4000/hooks',
    eventTypes: ['appointment.*'],
  },
});
step(`subscribed the receiver (${subscription.id})`);

const { accessToken } = await call(`${SCHEDULING}/api/auth/login`, {
  method: 'POST',
  body: { email: 'maria@scheduling.demo', password: 'Customer123!' },
});
const professionals = await call(`${SCHEDULING}/api/professionals?pageSize=50`);
const professional = professionals.items.find((p) => p.serviceIds.length > 0);
const serviceId = professional.serviceIds[0];

let slot;
for (let day = 1; day <= 14 && !slot; day++) {
  const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
  const availability = await call(
    `${SCHEDULING}/api/professionals/${professional.id}/availability?serviceId=${serviceId}&date=${date}`,
  );
  slot = availability.slots[0];
}
if (!slot) throw new Error('No free slot in the next two weeks');

const appointment = await call(`${SCHEDULING}/api/appointments`, {
  method: 'POST',
  token: accessToken,
  body: { professionalId: professional.id, serviceId, startsAt: slot.startsAt },
});
step(`booked appointment ${appointment.id} at ${slot.startsAt}`);

const created = await waitFor('appointment.created at the receiver', async () => {
  const received = await call(`${RECEIVER}/received`);
  return received.find((r) => JSON.parse(r.body).type === 'appointment.created');
});
const createdBody = JSON.parse(created.body);
if (createdBody.data.appointmentId !== appointment.id)
  throw new Error('Webhook is about another appointment');
if (createdBody.source !== 'scheduling-api')
  throw new Error(`Unexpected source ${createdBody.source}`);
if (!verifySignature(subscription.secret, created.headers, created.body))
  throw new Error('Invalid signature');
step('receiver got appointment.created with a valid signature');

await call(`${SCHEDULING}/api/appointments/${appointment.id}/cancel`, {
  method: 'POST',
  token: accessToken,
  body: { reason: 'e2e' },
});
const cancelled = await waitFor('appointment.cancelled at the receiver', async () => {
  const received = await call(`${RECEIVER}/received`);
  return received.find((r) => JSON.parse(r.body).type === 'appointment.cancelled');
});
if (!verifySignature(subscription.secret, cancelled.headers, cancelled.body))
  throw new Error('Invalid signature');
step('receiver got appointment.cancelled with a valid signature');

const deliveries = await call(`${RELAY}/deliveries?subscriptionId=${subscription.id}`, {
  token: ADMIN_KEY,
});
if (deliveries.items.length !== 2 || deliveries.items.some((d) => d.status !== 'succeeded')) {
  throw new Error(`Unexpected deliveries: ${JSON.stringify(deliveries.items)}`);
}
step('WebhookRelay shows both deliveries as succeeded');
console.log('End-to-end test passed');
