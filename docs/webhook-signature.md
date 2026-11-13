# Verifying webhooks

Every webhook WebhookRelay sends carries three headers, following the
[Standard Webhooks](https://www.standardwebhooks.com) specification:

| Header              | Example                                | Meaning                                                                  |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `webhook-id`        | `01938a2b-0000-7000-8000-000000000001` | The event id. **Identical on every retry**: store it and ignore repeats. |
| `webhook-timestamp` | `1796731200`                           | Unix seconds when this attempt was signed.                               |
| `webhook-signature` | `v1,DG80Ebv... v1,GDTa0Y7...`          | One `v1,<base64>` per active secret, space-separated.                    |

The signature is `base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))`, where
`key` is the base64-decoded part of your secret after the `whsec_` prefix.

## What a receiver must do

1. **Use the raw body.** Verify the exact bytes received, before any JSON parsing or re-serialization.
2. **Check the timestamp.** Reject requests more than 5 minutes away from your clock. The timestamp
   is inside the signed content, so an attacker who captured a request cannot replay it later with a
   fresh timestamp.
3. **Compare in constant time** (`timingSafeEqual`, `CryptographicOperations.FixedTimeEquals`). An
   ordinary string comparison stops at the first different byte, and measuring response times would
   let an attacker discover a valid signature byte by byte.
4. **Accept any matching signature.** After a secret rotation, WebhookRelay signs with the new and
   the old secret for 24 hours, so you can deploy the new secret without losing events.
5. **Deduplicate by `webhook-id`** (delivery is at least once) and answer `2xx` quickly.

## Node.js

Any Standard Webhooks library works, for example [`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks):

```ts
import { Webhook } from 'standardwebhooks';

const webhook = new Webhook(process.env.WEBHOOK_SECRET!); // "whsec_..."

app.post('/hooks', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = webhook.verify(req.body, req.headers); // throws if invalid or stale
    // dedupe on req.headers['webhook-id'], then handle `event`
    res.sendStatus(204);
  } catch {
    res.sendStatus(401);
  }
});
```

Without a library, the same steps with `node:crypto`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(
  secret: string,
  id: string,
  timestamp: string,
  signature: string,
  body: string,
): boolean {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(' ').some((part) => {
    if (!part.startsWith('v1,')) return false;
    const received = Buffer.from(part.slice(3), 'base64');
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}
```

## C# / .NET

```csharp
using System.Security.Cryptography;
using System.Text;

public static bool Verify(string secret, string id, string timestamp, string signature, string body, DateTimeOffset now)
{
    if (!long.TryParse(timestamp, out var seconds)
        || (now - DateTimeOffset.FromUnixTimeSeconds(seconds)).Duration() > TimeSpan.FromMinutes(5))
    {
        return false;
    }

    var key = Convert.FromBase64String(secret["whsec_".Length..]);
    var expected = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"{id}.{timestamp}.{body}"));

    Span<byte> received = stackalloc byte[64];
    foreach (var part in signature.Split(' ', StringSplitOptions.RemoveEmptyEntries))
    {
        if (part.StartsWith("v1,", StringComparison.Ordinal)
            && Convert.TryFromBase64String(part[3..], received, out var length)
            && CryptographicOperations.FixedTimeEquals(received[..length], expected))
        {
            return true;
        }
    }

    return false;
}
```

## These snippets are tested

- WebhookRelay's own `verify` (`src/domain/signature.ts`) is tested against the official
  `standardwebhooks` library in both directions and against the specification's published vector.
- The C# version above lives in SchedulingApi's test suite (`WebhookSignatureContractTests`), where
  it verifies a signature produced by WebhookRelay's Node code. WebhookRelay's test suite pins the
  same vector, so a change on either side breaks a build.
