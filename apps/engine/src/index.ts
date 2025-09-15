import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import {
  authMiddleware,
  loggingMiddleware,
  securityMiddleware,
} from "./middleware";
import accountRoutes from "./routes/accounts";
import authRoutes from "./routes/auth";
import connectionRoutes from "./routes/connections";
import healthRoutes from "./routes/health";
import institutionRoutes from "./routes/institutions";
import ratesRoutes from "./routes/rates";
import transactionsRoutes from "./routes/transactions";

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ success: false, errors: result.error.errors }, 422);
    }
  },
});

app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3001", // Development
      "https://app.midday.ai", // Production
      "https://beta.midday.ai", // Staging
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "Accept",
      "Origin",
      "X-Requested-With",
    ],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
  }),
);

app.use(authMiddleware);
app.use(securityMiddleware);
app.use(loggingMiddleware);

app.get("/", (c) => {
  return c.redirect("https://midday.ai", 302);
});

export const appRoutes = app
  .route("/transactions", transactionsRoutes)
  .route("/accounts", accountRoutes)
  .route("/institutions", institutionRoutes)
  .route("/auth", authRoutes)
  .route("/connections", connectionRoutes)
  .route("/health", healthRoutes)
  .route("/rates", ratesRoutes);

export type AppType = typeof appRoutes;

export default app;
