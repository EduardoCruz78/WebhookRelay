import { defineConfig } from 'drizzle-kit';

// Only `generate` is used: it turns schema changes into reviewable SQL files under drizzle/.
// The application applies them at startup or in the pipeline (see src/infrastructure/db/migrate.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/db/schema.ts',
  out: './drizzle',
});
