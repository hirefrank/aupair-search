import { fetchWithRetry } from "../lib/http.js";
import { parseJsonSafe } from "../lib/utils.js";

type RefreshInput = {
  region: string;
  clientId: string;
  refreshToken: string;
};

type RefreshResult = {
  idToken: string;
  accessToken: string | null;
  expiresInSeconds: number | null;
};

export async function refreshCognitoIdToken({
  region,
  clientId,
  refreshToken
}: RefreshInput): Promise<RefreshResult> {
  if (!region || !clientId || !refreshToken) {
    throw new Error("Missing region/clientId/refreshToken for Cognito refresh");
  }

  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth"
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken
        }
      })
    },
    {
      retries: 4,
      minDelayMs: 400,
      maxDelayMs: 8_000,
      timeoutMs: 20_000
    }
  );

  const raw = await response.text();
  const json = parseJsonSafe<Record<string, unknown>>(raw, {});

  if (!response.ok) {
    throw new Error(
      `Cognito refresh failed (${response.status}): ${String(json.message || raw).slice(0, 300)}`
    );
  }

  const authResult =
    typeof json.AuthenticationResult === "object" && json.AuthenticationResult
      ? (json.AuthenticationResult as Record<string, unknown>)
      : null;

  const idToken = typeof authResult?.IdToken === "string" ? authResult.IdToken : null;
  if (!idToken) {
    throw new Error("Cognito refresh succeeded but no IdToken returned");
  }

  return {
    idToken,
    accessToken: typeof authResult?.AccessToken === "string" ? authResult.AccessToken : null,
    expiresInSeconds: typeof authResult?.ExpiresIn === "number" ? authResult.ExpiresIn : null
  };
}
