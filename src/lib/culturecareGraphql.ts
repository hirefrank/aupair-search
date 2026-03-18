import { refreshCognitoIdToken } from "../auth/cognito.js";
import { fetchWithRetry } from "./http.js";
import { isTokenFresh } from "./utils.js";

const DEFAULT_GRAPHQL_ENDPOINT =
  "https://jn6xymv2sfgljcnnjzffb7jaum.appsync-api.us-east-1.amazonaws.com/graphql";

const DEFAULT_AVAILABLE_ENDPOINT =
  "https://4bzk4o198j.execute-api.us-east-1.amazonaws.com/prod/matching/search/au-pairs/available";

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

const FAVORITES_BY_HOST_FAMILY_QUERY = `query FavoritesByHostFamily($hfId: ID!, $limit: Int) {
  __typename
  favoritesByHostFamily(hfId: $hfId, limit: $limit, status: {eq: "Favorited"}) {
    __typename
    items {
      __typename
      id
      owner
      apId
      hfId
      status
      note
      recommendationReason
      recommendedBy
      favoritedAt
      unfavoritedAt
      createdAt
      updatedAt
    }
    nextToken
  }
}`;

export type CultureCareFavorite = {
  favoriteId: string;
  apId: string;
  favoritedAt: string | null;
  updatedAt: string | null;
};

export type CultureCareAvailability = {
  apId: string;
  available: boolean;
  isVisible: boolean;
  reason?: string;
  subReason?: string;
};

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

  try {
    const refreshed = await refreshCognitoIdToken({ region, clientId, refreshToken });
    return refreshed.idToken;
  } catch (error) {
    if (direct) return direct;
    throw error;
  }
}

export async function getCultureCareIdToken(env: NodeJS.ProcessEnv): Promise<string> {
  const direct = env.CULTURECARE_ID_TOKEN;
  if (direct && isTokenFresh(direct, 120)) return direct;

  const refreshToken = env.CULTURECARE_REFRESH_TOKEN;
  const clientId = env.CULTURECARE_COGNITO_CLIENT_ID || "3jsqobi851prmu958rn4b0t26e";
  const region = env.CULTURECARE_COGNITO_REGION || "us-east-1";

  if (!refreshToken) {
    const fallback = env.CULTURECARE_BEARER;
    if (fallback) return fallback;
    throw new Error("No CULTURECARE_ID_TOKEN, CULTURECARE_BEARER or CULTURECARE_REFRESH_TOKEN found");
  }

  try {
    const refreshed = await refreshCognitoIdToken({ region, clientId, refreshToken });
    return refreshed.idToken;
  } catch (error) {
    if (direct) return direct;
    const fallback = env.CULTURECARE_BEARER;
    if (fallback) return fallback;
    throw error;
  }
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

export async function listFavoritedAuPairs(params: {
  bearerToken: string;
  hfId: string;
  endpoint?: string;
  limit?: number;
}): Promise<CultureCareFavorite[]> {
  const endpoint = params.endpoint || DEFAULT_GRAPHQL_ENDPOINT;
  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        authorization: `${params.bearerToken}`,
        "content-type": "application/json; charset=utf-8",
        accept: "application/json"
      },
      body: JSON.stringify({
        operationName: null,
        variables: {
          hfId: params.hfId,
          limit: params.limit ?? 500
        },
        query: FAVORITES_BY_HOST_FAMILY_QUERY
      })
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
    throw new Error(message);
  }

  const errors = Array.isArray(json.errors) ? json.errors : [];
  if (errors.length > 0) {
    const firstError = errors[0] as Record<string, unknown>;
    throw new Error(typeof firstError.message === "string" ? firstError.message : "GraphQL error");
  }

  const items = ((((json.data as Record<string, unknown> | undefined)?.favoritesByHostFamily as Record<string, unknown> | undefined)
    ?.items as unknown[]) || []) as Record<string, unknown>[];

  const deduped = new Map<string, CultureCareFavorite>();
  for (const item of items) {
    const apId = typeof item.apId === "string" ? item.apId : "";
    if (!apId) continue;
    if (item.unfavoritedAt) continue;
    const next: CultureCareFavorite = {
      favoriteId: typeof item.id === "string" ? item.id : apId,
      apId,
      favoritedAt: typeof item.favoritedAt === "string" ? item.favoritedAt : null,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null
    };
    const current = deduped.get(apId);
    if (!current) {
      deduped.set(apId, next);
      continue;
    }
    const currentTime = Date.parse(current.updatedAt || current.favoritedAt || "") || 0;
    const nextTime = Date.parse(next.updatedAt || next.favoritedAt || "") || 0;
    if (nextTime >= currentTime) deduped.set(apId, next);
  }

  return [...deduped.values()];
}

export async function getAuPairAvailability(params: {
  bearerToken: string;
  apIds: string[];
  endpoint?: string;
}): Promise<CultureCareAvailability[]> {
  if (!params.apIds.length) return [];
  const endpoint = params.endpoint || DEFAULT_AVAILABLE_ENDPOINT;
  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.bearerToken}`,
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
        "x-amz-user-agent": "amplify-flutter/1.8.0 Chrome/145.0.0.0 API/54"
      },
      body: JSON.stringify({ auPairLoginIds: params.apIds })
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
    throw new Error(message);
  }

  const auPairs = (Array.isArray(json.auPairs) ? json.auPairs : []) as Record<string, unknown>[];
  const out: CultureCareAvailability[] = [];
  for (const item of auPairs) {
    const apId = typeof item.auPairLoginId === "string" ? item.auPairLoginId : "";
    if (!apId) continue;
    out.push({
      apId,
      available: item.available === true,
      isVisible: item.isVisible !== false,
      reason: typeof item.reason === "string" ? item.reason : undefined,
      subReason: typeof item.subReason === "string" ? item.subReason : undefined
    });
  }
  return out;
}
