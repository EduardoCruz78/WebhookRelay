import { z } from 'zod';

import { Database } from './infrastructure/db/database.js';
import { runMigrations } from './infrastructure/db/migrate.js';

/** `npm run db:migrate` / `node dist/migrate.js`: applies pending migrations and exits. */
const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env);

const database = Database.connect(DATABASE_URL, { max: 1 });
try {
  await runMigrations(database.db);
} finally {
  await database.close();
}
