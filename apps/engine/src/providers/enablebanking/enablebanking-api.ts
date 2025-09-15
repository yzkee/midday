import { Buffer } from "node:buffer";
import { ProviderError } from "@engine/utils/error";
import { formatISO, subDays } from "date-fns";
import * as jose from "jose";
import xior, { type XiorInstance, type XiorRequestConfig } from "xior";
import type { GetTransactionsRequest, ProviderParams } from "../types";
import { transformSessionData } from "./transform";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  GetAccountDetailsResponse,
  GetAccountsRequest,
  GetAspspsResponse,
  GetBalancesResponse,
  GetExchangeCodeResponse,
  GetSessionResponse,
  GetTransactionsResponse,
} from "./types";

export class EnableBankingApi {
  #baseUrl = "https://api.enablebanking.com";
  #redirectUrl: string;
  #applicationId: string;
  #keyContent: string;

  // Maximum allowed TTL is 24 hours (86400 seconds)
  #expiresIn = 20; // hours

  constructor(params: Omit<ProviderParams, "provider">) {
    this.#applicationId =
      params.envs.ENABLEBANKING_APPLICATION_ID ||
      process.env.ENABLEBANKING_APPLICATION_ID!;

    this.#keyContent =
      params.envs.ENABLE_BANKING_KEY_CONTENT ||
      process.env.ENABLE_BANKING_KEY_CONTENT!;

    this.#redirectUrl =
      params.envs.ENABLEBANKING_REDIRECT_URL ||
      process.env.ENABLEBANKING_REDIRECT_URL!;
  }

  #encodeData(data: object) {
    return jose.base64url.encode(Buffer.from(JSON.stringify(data)));
  }

  #getJWTHeader() {
    return this.#encodeData({
      typ: "JWT",
      alg: "RS256",
      kid: this.#applicationId,
    });
  }

  #getJWTBody(exp: number) {
    const timestamp = Math.floor(Date.now() / 1000);
    return this.#encodeData({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: timestamp,
      exp: timestamp + exp,
    });
  }

  async #signWithKey(data: string) {
    try {
      const keyBuffer = Buffer.from(this.#keyContent, "base64");
      const pemKey = keyBuffer.toString("utf8");

      const privateKey = await jose.importPKCS8(pemKey, "RS256");

      const signature = await crypto.subtle.sign(
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: { name: "SHA-256" },
        },
        // @ts-ignore
        privateKey,
        new TextEncoder().encode(data),
      );

      return jose.base64url.encode(new Uint8Array(signature));
    } catch (error) {
      console.error("Error in JWT signing:", error);
      throw error;
    }
  }

  async #generateJWT() {
    const exp = this.#expiresIn * 60 * 60;
    const jwtHeaders = this.#getJWTHeader();
    const jwtBody = this.#getJWTBody(exp);
    const jwtSignature = await this.#signWithKey(`${jwtHeaders}.${jwtBody}`);

    return `${jwtHeaders}.${jwtBody}.${jwtSignature}`;
  }

  async #getApi(): Promise<XiorInstance> {
    const jwt = await this.#generateJWT();

    return xior.create({
      baseURL: this.#baseUrl,
      timeout: 30_000,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    });
  }

  async #get<TResponse>(
    path: string,
    params?: Record<string, string>,
    config?: XiorRequestConfig,
  ): Promise<TResponse> {
    const api = await this.#getApi();

    return api
      .get<TResponse>(path, {
        params,
        ...config,
        headers: {
          ...config?.headers,
          "Psu-Ip-Address": Array.from(
            { length: 4 },
            () => ~~(Math.random() * 256),
          ).join("."),
          "Psu-User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      })
      .then(({ data }) => data);
  }

  async #post<TResponse>(
    path: string,
    body?: unknown,
    config?: XiorRequestConfig,
  ): Promise<TResponse> {
    const api = await this.#getApi();

    return api.post<TResponse>(path, body, config).then(({ data }) => data);
  }

  async authenticate(
    params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    const { country, institutionId, teamId, validUntil, state, type } = params;

    try {
      const response = await this.#post<AuthenticateResponse>("/auth", {
        access: {
          balances: true,
          transactions: true,
          valid_until: validUntil,
        },
        aspsp: {
          name: institutionId,
          country,
        },
        psu_type: type,
        psu_id: teamId,
        redirect_url: this.#redirectUrl,
        state,
      });

      return response;
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  async exchangeCode(code: string) {
    try {
      const response = await this.#post<GetExchangeCodeResponse>("/sessions", {
        code,
      });

      return transformSessionData(response);
    } catch (error) {
      console.log(error);
      throw new ProviderError({
        message: "Failed to exchange code",
        // @ts-ignore
        code: error.response?.data?.error ?? "ENABLEBANKING_ERROR",
      });
    }
  }

  async getSession(sessionId: string): Promise<GetSessionResponse> {
    return this.#get<GetSessionResponse>(`/sessions/${sessionId}`);
  }

  async getHealthCheck(): Promise<boolean> {
    try {
      await this.#get<{ message: string }>("/application");
      return true;
    } catch (error) {
      return false;
    }
  }

  async getInstitutions(): Promise<GetAspspsResponse["aspsps"]> {
    const response = await this.#get<GetAspspsResponse>("/aspsps");

    return response.aspsps;
  }

  async getAccountDetails(
    accountId: string,
  ): Promise<GetAccountDetailsResponse> {
    return this.#get<GetAccountDetailsResponse>(
      `/accounts/${accountId}/details`,
    );
  }

  async getAccounts({
    id,
  }: GetAccountsRequest): Promise<GetAccountDetailsResponse[]> {
    try {
      console.log(`[EnableBanking] Getting accounts for session: ${id}`);
      const startTime = Date.now();

      const session = await this.getSession(id);
      console.log(
        `[EnableBanking] Session retrieved, found ${session.accounts.length} accounts`,
      );

      // Optimize: Process accounts with timeout and error resilience
      const ACCOUNT_TIMEOUT = 8000; // 8 seconds per account (reduced for reliability)
      const MAX_CONCURRENT = 2; // Limit concurrent requests (reduced to prevent overload)

      const processAccountBatch = async (
        accountIds: string[],
      ): Promise<PromiseSettledResult<GetAccountDetailsResponse>[]> => {
        return Promise.allSettled(
          accountIds.map(
            async (accountId, index): Promise<GetAccountDetailsResponse> => {
              const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(
                  () =>
                    reject(
                      new Error(`Timeout processing account ${accountId}`),
                    ),
                  ACCOUNT_TIMEOUT,
                );
              });

              const accountPromise =
                (async (): Promise<GetAccountDetailsResponse> => {
                  console.log(
                    `[EnableBanking] Processing account ${index + 1}/${accountIds.length}: ${accountId}`,
                  );

                  const [details, balance] = await Promise.all([
                    this.getAccountDetails(accountId),
                    this.getAccountBalance(accountId),
                  ]);

                  return {
                    ...details,
                    institution: session.aspsp,
                    valid_until: session.access.valid_until,
                    balance,
                  };
                })();

              return Promise.race([accountPromise, timeoutPromise]);
            },
          ),
        );
      };

      // Process accounts in batches to avoid overwhelming the API
      const accountBatches: string[][] = [];
      for (let i = 0; i < session.accounts.length; i += MAX_CONCURRENT) {
        accountBatches.push(session.accounts.slice(i, i + MAX_CONCURRENT));
      }

      const allResults: PromiseSettledResult<GetAccountDetailsResponse>[] = [];
      for (const batch of accountBatches) {
        const batchResults = await processAccountBatch(batch);
        allResults.push(...batchResults);
      }

      // Separate successful and failed accounts
      const successfulAccounts: GetAccountDetailsResponse[] = [];
      const failedAccounts: string[] = [];

      allResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          successfulAccounts.push(result.value);
        } else {
          const accountId = session.accounts[index];
          failedAccounts.push(accountId);
          console.error(
            `[EnableBanking] Failed to process account ${accountId}:`,
            result.reason,
          );
        }
      });

      const duration = Date.now() - startTime;
      console.log(
        `[EnableBanking] Processed ${successfulAccounts.length}/${session.accounts.length} accounts successfully in ${duration}ms`,
      );

      if (failedAccounts.length > 0) {
        console.warn(
          `[EnableBanking] ${failedAccounts.length} accounts failed: ${failedAccounts.join(", ")}`,
        );
      }

      // Return successful accounts even if some failed
      if (successfulAccounts.length === 0) {
        throw new Error(`All accounts failed to process for session ${id}`);
      }

      return successfulAccounts;
    } catch (error) {
      console.error(
        `[EnableBanking] getAccounts error for session ${id}:`,
        error,
      );
      throw error;
    }
  }

  async getAccountBalance(
    accountId: string,
  ): Promise<GetBalancesResponse["balances"][0]> {
    const response = await this.#get<GetBalancesResponse>(
      `/accounts/${accountId}/balances`,
    );

    // Find balance with highest amount
    const highestBalance = response.balances.reduce((max, current) => {
      const currentAmount = Number.parseFloat(current.balance_amount.amount);
      const maxAmount = Number.parseFloat(max.balance_amount.amount);
      return currentAmount > maxAmount ? current : max;
    }, response.balances[0]);

    return highestBalance;
  }

  async getTransactions({
    accountId,
    latest,
  }: GetTransactionsRequest): Promise<GetTransactionsResponse> {
    return this.#get<GetTransactionsResponse>(
      `/accounts/${accountId}/transactions`,
      {
        strategy: latest ? "default" : "longest",
        transaction_status: "BOOK",
        ...(latest && {
          date_from: formatISO(subDays(new Date(), 5), {
            representation: "date",
          }),
        }),
      },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const api = await this.#getApi();
    await api.delete(`/sessions/${sessionId}`);
  }
}
