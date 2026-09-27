# Plan — plugin `x-context` (mes tweets comme contexte d'écriture)

Date : 2026-09-27 · Statut : livré (v0.1.0) — reste la validation live avec les vraies clés

## Objectif

Donner à mes agents (Claude Code, Cowork) un accès **en lecture seule** à mes propres
posts X, avec leurs métriques, pour qu'ils écrivent les prochains tweets en s'appuyant
sur ce qui a marché, sans me répéter.

## Contraintes

- **API X officielle, pay-per-use** (sept. 2026) : 0,005 $ par post lu en app-only,
  0,001 $ en « owned read » (user context, compte propriétaire de l'app). Pas de tier gratuit.
  Relire le même post dans la même journée UTC n'est facturé qu'une fois.
  → **cache local obligatoire** : chaque tweet n'est payé qu'une fois, les agents lisent le cache (gratuit).
- Endpoint timeline : `GET /2/users/{id}/tweets`, 3 200 posts les plus récents max, 5–100 par page.
- La spec OpenAPI actuelle nomme les champs `post.fields`, `note_post`, `referenced_posts`.
  Parsing tolérant aux anciens noms (`tweet.fields`, `note_tweet`, `referenced_tweets`, `retweet_count`)
  + retry unique avec `tweet.fields` si l'API renvoie 400.
- `non_public_metrics` / `organic_metrics` : user context + 30 derniers jours seulement.
- Aucun secret dans le repo (le marketplace est public). Tokens via `userConfig` `sensitive`.
- **Lecture seule** : le plugin ne publie jamais rien.

## Architecture

```
plugins/x-context/
├── .claude-plugin/plugin.json   # userConfig (tokens sensibles) + mcpServers inline
├── dist/server.mjs              # bundle esbuild commité (aucun npm install côté user)
├── src/                         # TypeScript : config, oauth1, x-client, store, sync, analytics, format, server
├── tests/                       # bun test
└── skills/write-tweet/SKILL.md  # workflow de rédaction
```

- **Auth** : OAuth 1.0a user context (4 clés du Developer Console, pas de refresh) → owned reads 5× moins chères
  + métriques organiques. Repli : Bearer token app-only + `x_username`.
- **Cache** : `${CLAUDE_PLUGIN_DATA}/tweets.json` (écriture atomique tmp + rename). Retweets exclus.
- **Outils MCP** :
  - `x_sync` — incrémental (`since_id`), `backfill` (`until_id`), `refresh_metrics_days`, plafond `max_posts`, `dry_run`, coût estimé.
  - `x_list_posts` — filtre/tri/recherche dans le cache (recent, engagement, impressions, taux).
  - `x_writing_context` — pack prêt à l'emploi : stats de perf (format, longueur, heure, jour), top posts, posts récents.

## Étapes

- [x] 1. Recherche : format plugin (`userConfig`, `${CLAUDE_PLUGIN_DATA}`), spec OpenAPI X, pricing
- [x] 2. Scaffold package (TS, esbuild, bun test, MCP SDK 1.30, zod 4)
- [x] 3. `oauth1.ts` + test vecteur officiel de signature
- [x] 4. `x-client.ts` : auth, pagination, erreurs (401/402/403/429), fallback legacy fields
- [x] 5. `store.ts` + `sync.ts` (tests avec fetch mocké)
- [x] 6. `analytics.ts` + `format.ts` (tests)
- [x] 7. `server.ts` MCP + bundle + smoke test stdio (initialize, tools/list, tools/call sur fixture)
- [x] 8. Skill `write-tweet` + manifest + entrée marketplace + README
- [x] 9. `claude plugin validate`, commits atomiques, push

## Critères d'acceptation

- `bun test` vert, `tsc --noEmit` vert, `claude plugin validate .` OK.
- Le bundle démarre avec `node dist/server.mjs` et répond à `tools/list` avec les 3 outils.
- Sans credentials : erreur claire et actionnable, pas de crash.
- Deux `x_sync` successifs sans nouveau tweet → 0 post facturé au second (hors refresh).

## Risques

- Nommage `post.*` vs `tweet.*` côté API live → fallback + parsing tolérant.
- Substitution de `${user_config.X}` non renseigné : défaut `""`, et le serveur ignore toute valeur vide ou `${...}` littérale.
- Pas de test live possible sans les clés de Tom → à valider au premier `x_sync` (`dry_run` d'abord).

## Rollback

Retirer l'entrée `x-context` de `marketplace.json` et le dossier `plugins/x-context`.

## Résultat (2026-09-27)

- 31 tests verts (dont e2e : bundle lancé en stdio contre un faux api.x.com local), `tsc` vert, `claude plugin validate` OK sur le plugin et le marketplace.
- Non vérifié : appel réel à l'API X (pas de clés) et chargement dans une session Claude Code interactive
  (la CLI headless n'était pas authentifiée). Premier test live : `x_sync` avec `dry_run: true`, puis `max_posts: 20`.
