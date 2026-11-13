import { parseArgs } from 'node:util';

import { z } from 'zod';

import { newId } from '../application/ids.js';
import { generateApiKey, hashApiKey, isValidSource } from '../domain/api-key.js';
import { Database } from '../infrastructure/db/database.js';

/**
 * Creates an API key and prints it once. Only its SHA-256 hash is stored.
 *
 *   npm run apikey:create -- --name "SchedulingApi" --role source --source scheduling-api
 *   npm run apikey:create -- --name "Ops" --role admin
 */
const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    role: { type: 'string' },
    source: { type: 'string' },
  },
});

const args = z
  .object({
    name: z.string().min(1),
    role: z.enum(['source', 'admin']),
    source: z.string().refine(isValidSource, 'lowercase letters, digits and dashes').optional(),
  })
  .refine((a) => (a.role === 'source') === (a.source !== undefined), {
    message: '--source is required for (and only for) --role source',
  })
  .parse(values);

const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env);
const database = Database.connect(DATABASE_URL, { max: 1 });
try {
  const key = generateApiKey();
  await database.repositories.apiKeys.insert({
    id: newId(),
    name: args.name,
    role: args.role,
    source: args.source ?? null,
    keyHash: hashApiKey(key),
    createdAt: new Date(),
    revokedAt: null,
  });
  process.stdout.write(`${key}\n`);
  process.stderr.write('Store this key now: it cannot be shown again.\n');
} finally {
  await database.close();
}
