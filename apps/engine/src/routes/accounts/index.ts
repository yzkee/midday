import type { Bindings } from "@engine/common/bindings";
import { ErrorSchema } from "@engine/common/schema";
import { Provider } from "@engine/providers";
import { createErrorResponse } from "@engine/utils/error";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { env } from "hono/adapter";
import {
  AccountBalanceParamsSchema,
  AccountBalanceSchema,
  AccountsParamsSchema,
  AccountsSchema,
  DeleteAccountsParamsSchema,
  DeleteSchema,
} from "./schema";

const app = new OpenAPIHono<{ Bindings: Bindings }>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      summary: "Get Accounts",
      request: {
        query: AccountsParamsSchema,
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: AccountsSchema,
            },
          },
          description: "Retrieve accounts",
        },
        400: {
          content: {
            "application/json": {
              schema: ErrorSchema,
            },
          },
          description: "Returns an error",
        },
      },
    }),
    async (c) => {
      const envs = env(c);

      const { provider, accessToken, institutionId, id } = c.req.valid("query");

      console.log(
        `[Accounts] Request: provider=${provider}, id=${id ? "present" : "missing"}`,
      );

      const api = new Provider({
        provider,
        kv: c.env.KV,
        fetcher: c.env.TELLER_CERT,
        envs,
      });

      try {
        const startTime = Date.now();

        // Add overall timeout for the entire request (with unbound workers: 30s limit)
        const TOTAL_TIMEOUT = 28000; // 28 seconds (leave 2s buffer)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Request timeout")), TOTAL_TIMEOUT);
        });

        const accountsPromise = api.getAccounts({
          id,
          accessToken,
          institutionId,
        });

        const data = await Promise.race([accountsPromise, timeoutPromise]);

        const duration = Date.now() - startTime;
        console.log(
          `[Accounts] Success: ${data.length} accounts retrieved in ${duration}ms`,
        );

        return c.json(
          {
            data,
          },
          200,
        );
      } catch (error) {
        console.error(
          `[Accounts] Error for provider=${provider}, id=${id}:`,
          error,
        );
        const errorResponse = createErrorResponse(error);

        return c.json(errorResponse, 400);
      }
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/",
      summary: "Delete Accounts",
      request: {
        query: DeleteAccountsParamsSchema,
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: DeleteSchema,
            },
          },
          description: "Retrieve accounts",
        },
        400: {
          content: {
            "application/json": {
              schema: ErrorSchema,
            },
          },
          description: "Returns an error",
        },
      },
    }),
    async (c) => {
      const envs = env(c);
      const { provider, accountId, accessToken } = c.req.valid("query");

      const api = new Provider({
        provider,
        fetcher: c.env.TELLER_CERT,
        kv: c.env.KV,
        envs,
      });

      try {
        await api.deleteAccounts({
          accessToken,
          accountId,
        });

        return c.json(
          {
            success: true,
          },
          200,
        );
      } catch (error) {
        const errorResponse = createErrorResponse(error);

        return c.json(errorResponse, 400);
      }
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/balance",
      summary: "Get Account Balance",
      request: {
        query: AccountBalanceParamsSchema,
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: AccountBalanceSchema,
            },
          },
          description: "Retrieve account balance",
        },
        400: {
          content: {
            "application/json": {
              schema: ErrorSchema,
            },
          },
          description: "Returns an error",
        },
      },
    }),
    async (c) => {
      const envs = env(c);
      const { provider, accessToken, id } = c.req.valid("query");

      const api = new Provider({
        provider,
        fetcher: c.env.TELLER_CERT,
        kv: c.env.KV,
        envs,
      });

      try {
        const data = await api.getAccountBalance({
          accessToken,
          accountId: id,
        });

        return c.json(
          {
            data,
          },
          200,
        );
      } catch (error) {
        const errorResponse = createErrorResponse(error);

        return c.json(errorResponse, 400);
      }
    },
  );

export default app;
