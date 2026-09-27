import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { credentialsPath, readCredentials, writeCredentials, type Auth } from "./config";
import { XApiError, XClient, type XUser } from "./x-client";

export interface ConnectOptions {
  dataDir: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  /** Shown on the page so the user knows what they're replacing. */
  current?: { username?: string; source: string };
}

export interface ConnectFlow {
  url: string;
  expiresAt: Date;
  /** Resolves with the connected account, or undefined if the page expired or was closed. */
  done: Promise<XUser | undefined>;
  isOpen(): boolean;
  close(): void;
}

const BODY_LIMIT = 16 * 1024;

/**
 * Serves a one-shot page on 127.0.0.1 where the user types their X keys.
 * The secrets go straight from the browser to this process and to disk, never
 * through the conversation. The random path token is the only way in; the Host
 * check stops DNS-rebinding pages from reaching it.
 */
export async function startConnectFlow(opts: ConnectOptions): Promise<ConnectFlow> {
  const token = randomBytes(24).toString("base64url");
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  let open = true;
  let resolveDone!: (user: XUser | undefined) => void;
  const done = new Promise<XUser | undefined>((r) => (resolveDone = r));

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, page("Erreur", `<p class="err">Erreur inattendue. Relance x_connect.</p>`));
    });
  });

  const close = (user?: XUser) => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    resolveDone(user);
  };
  const timer = setTimeout(() => close(), ttlMs);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const path = `/connect/${token}`;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 421, "Misdirected request", "text/plain");
    if (!sameToken(req.url ?? "", path)) return send(res, 404, "Not found", "text/plain");

    if (req.method === "GET") return send(res, 200, formPage(opts));
    if (req.method !== "POST") return send(res, 405, "Method not allowed", "text/plain");

    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) {
      return send(res, 403, "Forbidden", "text/plain");
    }
    const body = await readBody(req);
    if (body === undefined) return send(res, 413, "Payload too large", "text/plain");

    const form = new URLSearchParams(body);
    const field = (name: string) => form.get(name)?.trim() || undefined;
    const creds = {
      api_key: field("api_key"),
      api_secret: field("api_secret"),
      access_token: field("access_token"),
      access_token_secret: field("access_token_secret"),
      bearer_token: field("bearer_token"),
      username: field("username")?.replace(/^@/, ""),
    };

    const oauthCount = [creds.api_key, creds.api_secret, creds.access_token, creds.access_token_secret].filter(Boolean).length;
    let auth: Auth;
    if (oauthCount === 4) {
      auth = {
        kind: "oauth1",
        consumerKey: creds.api_key!,
        consumerSecret: creds.api_secret!,
        token: creds.access_token!,
        tokenSecret: creds.access_token_secret!,
      };
    } else if (oauthCount === 0 && creds.bearer_token && creds.username) {
      auth = { kind: "bearer", token: creds.bearer_token };
    } else {
      const msg =
        oauthCount > 0
          ? `Il manque ${4 - oauthCount} des 4 clés OAuth 1.0a.`
          : "Renseigne les 4 clés OAuth 1.0a (recommandé), ou un bearer token avec ton @.";
      return send(res, 400, formPage(opts, msg, creds.username));
    }

    let user: XUser;
    try {
      const client = new XClient(auth, opts.apiBase, opts.fetchImpl);
      user = auth.kind === "oauth1" ? await client.getMe() : await client.getUserByUsername(creds.username!);
    } catch (err) {
      const msg = err instanceof XApiError ? err.message : `Impossible de joindre l'API X : ${(err as Error).message}`;
      return send(res, 400, formPage(opts, `X a refusé ces clés. ${msg}`, creds.username));
    }

    writeCredentials(
      opts.dataDir,
      auth.kind === "oauth1"
        ? { ...creds, bearer_token: undefined, username: user.username }
        : { bearer_token: creds.bearer_token, username: user.username },
    );
    send(
      res,
      200,
      page(
        "Compte X connecté",
        `<h1>Connecté ✓</h1>
         <p>Compte <strong>@${esc(user.username)}</strong> (${auth.kind === "oauth1" ? "OAuth 1.0a, lectures à 0,001 $/post" : "bearer token, lectures à 0,005 $/post"}).</p>
         <p>Clés enregistrées dans <code>${esc(credentialsPath(opts.dataDir))}</code>.</p>
         <p>Tu peux fermer cet onglet et revenir à Claude.</p>`,
      ),
    );
    setImmediate(() => close(user));
  }

  return {
    url: `http://127.0.0.1:${port}${path}`,
    expiresAt: new Date(Date.now() + ttlMs),
    done,
    isOpen: () => open,
    close: () => close(),
  };
}

/** Best effort: the URL is also returned to the user, so a failure here is harmless. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // ignore
  }
}

function sameToken(url: string, expected: string): boolean {
  const actual = url.split("?")[0] ?? "";
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining so the client still gets the 413 instead of a reset connection.
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > BODY_LIMIT ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formPage(opts: ConnectOptions, error?: string, username?: string): string {
  const saved = readCredentials(opts.dataDir);
  const status = opts.current?.username
    ? `<p class="note">Actuellement : <strong>@${esc(opts.current.username)}</strong> (${esc(opts.current.source)}). Enregistrer ici remplace les clés sauvegardées.</p>`
    : saved?.username
      ? `<p class="note">Clés déjà enregistrées pour <strong>@${esc(saved.username)}</strong> ; les renseigner à nouveau les remplace.</p>`
      : "";
  const secret = (name: string, label: string, hint = "") => `
    <label>${label}${hint ? ` <span class="hint">${hint}</span>` : ""}
      <input type="password" name="${name}" autocomplete="off" spellcheck="false">
    </label>`;
  return page(
    "Connecter X à Claude",
    `<h1>Connecter ton compte X</h1>
     <p>Ces clés servent uniquement à <strong>lire tes propres posts</strong> (x-context ne publie jamais rien).
     Elles vont directement de cette page au serveur local x-context, sans passer par la conversation avec Claude.</p>
     ${status}
     ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
     <form method="post" autocomplete="off">
       <fieldset>
         <legend>Clés OAuth 1.0a <span class="badge">recommandé</span></legend>
         <p class="hint">console.x.com → ton app → <em>Keys and tokens</em>. Génère l'<em>Access Token</em> et son secret pour ton compte (permission Read). Lecture de tes posts : 0,001 $/post.</p>
         ${secret("api_key", "API Key", "(consumer key)")}
         ${secret("api_secret", "API Key Secret")}
         ${secret("access_token", "Access Token")}
         ${secret("access_token_secret", "Access Token Secret")}
       </fieldset>
       <label>Ton @ X <span class="hint">(optionnel avec OAuth, obligatoire avec un bearer token)</span>
         <input type="text" name="username" value="${esc(username ?? "")}" autocomplete="off" spellcheck="false" placeholder="sans le @">
       </label>
       <details>
         <summary>Ou bien : bearer token (app-only, 0,005 $/post, pas de métriques privées)</summary>
         ${secret("bearer_token", "Bearer Token")}
       </details>
       <button type="submit">Vérifier et enregistrer</button>
       <p class="hint">La vérification fait un appel à l'API X (lecture de ton profil). Enregistrement dans <code>${esc(credentialsPath(opts.dataDir))}</code>. Cette page expire dans 15 minutes.</p>
     </form>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fafaf9; --fg:#1c1917; --muted:#57534e; --card:#fff; --line:#e7e5e4; --accent:#1d4ed8; --err:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --fg:#f5f5f4; --muted:#a8a29e; --card:#1c1917; --line:#292524; --accent:#60a5fa; --err:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:34rem; margin:3rem auto; padding:0 1rem; }
  h1 { font-size:1.5rem; margin:0 0 .75rem; }
  p { margin:.5rem 0; }
  form, fieldset { display:grid; gap:.9rem; }
  form { margin-top:1.25rem; }
  fieldset { border:1px solid var(--line); border-radius:12px; padding:1rem; background:var(--card); }
  legend { font-weight:600; padding:0 .35rem; }
  label { display:grid; gap:.3rem; font-weight:500; }
  input { font:inherit; padding:.55rem .7rem; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
  input:focus-visible, button:focus-visible, summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  details { border:1px solid var(--line); border-radius:12px; padding:.75rem 1rem; }
  details[open] { display:grid; gap:.75rem; }
  summary { cursor:pointer; color:var(--muted); }
  button { font:inherit; font-weight:600; padding:.7rem 1rem; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .hint, .note { color:var(--muted); font-size:.9rem; font-weight:400; }
  .badge { font-size:.75rem; font-weight:600; color:var(--accent); border:1px solid currentColor; border-radius:999px; padding:0 .45rem; margin-left:.25rem; }
  .err { color:var(--err); font-weight:500; }
  code { font-size:.85em; word-break:break-all; }
</style></head>
<body><main>${body}</main></body></html>`;
}
