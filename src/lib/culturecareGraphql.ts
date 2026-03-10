import { refreshCognitoIdToken } from "../auth/cognito.js";
import { fetchWithRetry } from "./http.js";
import { isTokenFresh } from "./utils.js";

const DEFAULT_GRAPHQL_ENDPOINT =
  "https://jn6xymv2sfgljcnnjzffb7jaum.appsync-api.us-east-1.amazonaws.com/graphql";

const CREATE_FAVORITE_MUTATION = `mutation CreateFavoriteAuPairFavoriteAuPair($input: CreateFavoriteAuPairInput!, $condition: ModelFavoriteAuPairConditionInput) {
  __typename
  createFavoriteAuPair(input: $input, condition: $condition) {
    __typename
    id
    owner
    apId
    hfId
    status
    favoritedAt
    createdAt
    updatedAt
  }
}`;

type FavoriteResult = {
  ok: boolean;
  favoriteId?: string;
  error?: string;
};

export async function getCultureCareBearerToken(env: NodeJS.ProcessEnv): Promise<string> {
  const direct = env.CULTURECARE_BEARER;
  if (direct && isTokenFresh(direct, 120)) return direct;

  const refreshToken = env.CULTURECARE_REFRESH_TOKEN;
  const clientId = env.CULTURECARE_COGNITO_CLIENT_ID || "3jsqobi851prmu958rn4b0t26e";
  const region = env.CULTURECARE_COGNITO_REGION || "us-east-1";

  if (!refreshToken) {
    if (direct) return direct;
    throw new Error("No CULTURECARE_BEARER or CULTURECARE_REFRESH_TOKEN found");
  }

  const refreshed = await refreshCognitoIdToken({ region, clientId, refreshToken });
  return refreshed.idToken;
}

export async function favoriteAuPair(params: {
  bearerToken: string;
  apId: string;
  hfId: string;
  endpoint?: string;
}): Promise<FavoriteResult> {
  const endpoint = params.endpoint || DEFAULT_GRAPHQL_ENDPOINT;
  const now = new Date().toISOString().replace(/Z$/, "000000Z").replace(/(\.\d{9}).*Z$/, "$1Z");

  const body = JSON.stringify({
    operationName: null,
    variables: {
      input: {
        id: crypto.randomUUID(),
        apId: params.apId,
        hfId: params.hfId,
        status: "Favorited",
        note: "",
        recommendationReason: null,
        recommendedBy: null,
        favoritedAt: now,
        unfavoritedAt: null
      }
    },
    query: CREATE_FAVORITE_MUTATION
  });

  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.bearerToken}`,
        "content-type": "application/json; charset=utf-8",
        accept: "application/json"
      },
      body
    },
    {
      retries: 2,
      minDelayMs: 300,
      maxDelayMs: 3_000,
      timeoutMs: 10_000
    }
  );

  const json = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const message = typeof json.message === "string" ? json.message : `HTTP ${response.status}`;
    return { ok: false, error: message };
  }

  const errors = Array.isArray(json.errors) ? json.errors : [];
  if (errors.length > 0) {
    const firstError = errors[0] as Record<string, unknown>;
    const message = typeof firstError.message === "string" ? firstError.message : "GraphQL error";
    return { ok: false, error: message };
  }

  const data = json.data as Record<string, unknown> | undefined;
  const created = data?.createFavoriteAuPair as Record<string, unknown> | undefined;
  const favoriteId = typeof created?.id === "string" ? created.id : undefined;

  return { ok: true, favoriteId };
}
