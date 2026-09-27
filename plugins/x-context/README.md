# x-context

Tes propres posts X (avec leurs métriques) comme contexte pour tes agents, afin qu'ils écrivent les prochains à partir de ce qui a vraiment marché chez toi, sans te répéter.

- **Serveur MCP** (`x`) : lit ta timeline via l'API X officielle et la met en cache en local. Chaque post n'est payé qu'une fois : les agents lisent le cache gratuitement.
- **Skill `write-tweet`** : charge le contexte, vérifie que tu n'as pas déjà traité le sujet, applique ta voix (ta skill `*-writing-style` si elle existe) et propose 3 brouillons argumentés par tes chiffres.
- **Lecture seule** : rien n'est jamais publié.

## Mise en place

1. **App X** sur [console.x.com](https://console.x.com) : crée une app (ou reprends une existante), achète quelques crédits et **fixe un plafond de dépense** (quelques dollars suffisent largement).
2. **Keys and tokens** : récupère l'*API Key* et l'*API Key Secret*, puis génère un *Access Token* et son *Secret* pour **ton** compte (la permission Read suffit).
3. **Installation** :

   ```bash
   /plugin marketplace add AlphaLuppi/plugin-marketplace
   /plugin install x-context@alphaluppi-plugins
   ```

   Claude Code te demande les réglages à l'activation (sinon : `/plugin` → x-context → configure). Les clés sont masquées et rangées dans le trousseau sécurisé de l'OS, jamais dans `settings.json`.

4. **Utilisation** : `/x-context:write-tweet un post sur <sujet>`, ou simplement « écris-moi un tweet sur … ». Au premier lancement, la skill fait un `dry_run` et te montre le coût maximal avant la vraie synchro.

## Coûts (tarifs X pay-per-use, sept. 2026)

| Auth | Prix par post lu | Métriques privées (clics profil, clics lien…) |
|---|---|---|
| OAuth 1.0a, 4 clés (**recommandé**) | 0,001 $ (*owned read*) | oui, 30 derniers jours |
| Bearer token + username | 0,005 $ | non |

L'API n'expose que les ~3 200 posts les plus récents d'un compte : l'historique complet coûte donc au maximum ~3,20 $ en OAuth 1.0a (16 $ en bearer). Ensuite, une synchro quotidienne ne lit que les nouveaux posts. Relire le même post dans la même journée UTC n'est facturé qu'une fois par X.

## Outils MCP

| Outil | Coût | Rôle |
|---|---|---|
| `x_sync` | payant, plafonné par `max_posts` (200 par défaut) | `mode: "new"` (posts plus récents que le cache, et comble les trous laissés par une synchro interrompue) · `mode: "backfill"` (plus ancien) · `refresh_metrics_days` (remet à jour les métriques des N derniers jours) · `dry_run` |
| `x_writing_context` | gratuit | Le briefing : ta façon d'écrire, ce qui performe par format / longueur / pièce jointe / heure / jour, tes meilleurs et tes plus faibles posts, tes posts récents |
| `x_list_posts` | gratuit | Recherche, filtre et tri dans le cache (« est-ce que j'ai déjà dit ça ? ») |

**×usual** = engagement (likes + reposts + réponses + citations + bookmarks) divisé par ta médiane sur les ±45 jours autour du post. Ça neutralise la croissance de ton audience. Les métriques capturées moins de 48 h après publication sont exclues des classements jusqu'au prochain `refresh_metrics_days`.

## Cache

Par défaut `~/.claude/plugins/data/<id>/posts.json`, **supprimé à la désinstallation** sauf avec `--keep-data`. Renseigne le réglage *Cache directory* pour garder ailleurs les posts déjà payés. Les retweets sont ignorés ; les réponses sont gardées mais séparées de tes posts originaux dans les analyses.

## Hors Claude Code

Le serveur est un simple MCP stdio. Pour Claude Desktop ou un autre client :

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/chemin/vers/plugins/x-context/dist/server.mjs"],
      "env": {
        "X_API_KEY": "…",
        "X_API_SECRET": "…",
        "X_ACCESS_TOKEN": "…",
        "X_ACCESS_TOKEN_SECRET": "…",
        "X_CONTEXT_DATA_DIR": "/chemin/vers/cache"
      }
    }
  }
}
```

Autres variables : `X_BEARER_TOKEN` + `X_USERNAME` (repli), `X_TIMEZONE` (fuseau des analyses horaires, par défaut celui du système), `X_API_BASE_URL`.

## Développement

```bash
cd plugins/x-context
bun install
bun run check   # tsc + bun test + bundle dist/server.mjs
```

`dist/server.mjs` est commité (bundle esbuild autonome) pour que le plugin fonctionne sans `npm install`. Rebuild et commit après chaque changement dans `src/`.
