import { describe, expect, test } from "bun:test";
import { oauth1Header, percentEncode } from "../src/oauth1";

// Reference vector from X's "Creating a signature" guide (OAuth 1.0a).
const creds = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};

describe("oauth1Header", () => {
  test("matches the documented reference signature", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      creds,
      {
        nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        timestamp: "1318622958",
        bodyParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      },
    );
    expect(header).toContain(`oauth_signature="${percentEncode("hCtSmYh+iHYCEqBWrE7C7hYmtUk=")}"`);
    expect(header.startsWith("OAuth ")).toBe(true);
    expect(header).toContain('oauth_version="1.0"');
  });

  test("signs query params regardless of how the URL encodes them", () => {
    const opts = { nonce: "n", timestamp: "1" };
    const a = oauth1Header("GET", "https://api.x.com/2/users/1/tweets?post.fields=a%2Cb&max_results=5", creds, opts);
    const b = oauth1Header("GET", "https://api.x.com/2/users/1/tweets?max_results=5&post.fields=a,b", creds, opts);
    expect(a).toBe(b);
  });
});

describe("percentEncode", () => {
  test("encodes RFC 3986 reserved chars that encodeURIComponent leaves alone", () => {
    expect(percentEncode("a!b*c'(d)")).toBe("a%21b%2Ac%27%28d%29");
    expect(percentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
  });
});
