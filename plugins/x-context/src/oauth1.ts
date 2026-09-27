import { createHmac, randomBytes } from "node:crypto";

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding, as required by OAuth 1.0a (stricter than encodeURIComponent). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignOptions {
  nonce?: string;
  timestamp?: string;
  /** application/x-www-form-urlencoded body params, which are part of the signature. */
  bodyParams?: Record<string, string>;
}

/** Builds the `Authorization: OAuth ...` header value (HMAC-SHA1). */
export function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  opts: SignOptions = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };

  const parsed = new URL(url);
  const params: [string, string][] = [];
  parsed.searchParams.forEach((value, key) => params.push([key, value]));
  for (const [key, value] of Object.entries(opts.bodyParams ?? {})) params.push([key, value]);
  for (const [key, value] of Object.entries(oauth)) params.push([key, value]);

  const paramString = params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? compare(av, bv) : compare(ak, bk)))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase();
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join(
    "&",
  );
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k as keyof typeof headerParams])}"`)
      .join(", ")
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
