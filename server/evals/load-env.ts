/**
 * Loads the repo-root .env before anything else.
 *
 * config.ts does `import "dotenv/config"`, which reads `.env` relative to the
 * *current working directory* — and `npm run eval` runs from `server/`, where
 * there is no .env. The real one lives at the repo root next to
 * icp.config.json, so point dotenv at it explicitly.
 *
 * This must be the FIRST import in the runner: config.ts snapshots
 * process.env into its `config` object at module-eval time, and ESM evaluates
 * imports depth-first in source order. dotenv does not overwrite variables
 * that are already set, so an explicitly exported key still wins.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });
