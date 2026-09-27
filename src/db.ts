/**
 * Prisma client for this service's own (minimal — see prisma/schema.prisma)
 * schema, pointed at the same DATABASE_URL the main Veyra app uses. Not a
 * singleton-across-hot-reload guard like Next.js needs (no dev-mode
 * module-reloading concern here — this is a plain long-running Node
 * process), just a single shared instance for the process's lifetime.
 *
 * The PrismaPg adapter (not a bare `new PrismaClient()`) is required, not
 * optional, as of Prisma 7 — the datasource URL can no longer live in
 * schema.prisma itself (see prisma.config.ts, which handles that for the
 * CLI/migrations side); the runtime client needs its own explicit
 * connection via an adapter. Exactly the same pattern the main app's own
 * src/lib/prisma.ts already uses.
 */
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
