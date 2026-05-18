import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

/**
 * Plaid client.
 *
 * Singleton wrapper so route handlers and Temporal activities share
 * the same SDK instance. The Plaid client itself is stateless — what
 * matters is that we configure it once with the env-appropriate URL
 * + product set.
 */

let cached: PlaidApi | undefined;

export function getPlaidClient(): PlaidApi {
  if (cached) return cached;

  const env = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;
  const basePath = PlaidEnvironments[env];
  if (!basePath) throw new Error(`unknown PLAID_ENV: ${env}`);

  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID ?? '',
        'PLAID-SECRET':    process.env.PLAID_SECRET    ?? '',
      },
    },
  });
  cached = new PlaidApi(config);
  return cached;
}
