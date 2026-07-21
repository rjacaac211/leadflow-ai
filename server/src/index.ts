import express from "express";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { initGraphs } from "./agent/graph.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { leadsRouter } from "./routes/leads.js";

async function main(): Promise<void> {
  if (!config.databaseUrl) {
    logger.fatal("DATABASE_URL is required");
    process.exit(1);
  }

  await initGraphs();

  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  });

  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/leads", leadsRouter);

  app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        model: config.anthropicModel,
        hubspot: config.hubspotAccessToken ? "live" : "mock",
        resend: config.resendApiKey ? "live" : "mock",
        slack: config.slackWebhookUrl ? "live" : "mock",
      },
      "leadflow server listening",
    );
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "server failed to start");
  process.exit(1);
});
