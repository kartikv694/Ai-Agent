import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma generate/validate should still be able to load the config when
    // DATABASE_URL is not present. Database commands will require it.
    url: process.env.DATABASE_URL ?? "",
  },
});
