import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from the schema: `npm run db:generate`.
// The API applies them on startup.
export default defineConfig({
  dialect: 'sqlite',
  schema: './apps/api/src/app/db/schema.ts',
  out: './apps/api/src/app/db/migrations',
});
