# x-context

Tes propres posts X (avec leurs métriques) comme contexte pour tes agents, afin qu'ils écrivent les prochains à partir de ce qui a vraiment marché chez toi, sans te répéter.

- **Serveur MCP** : lit ta timeline via l'API X officielle et la met en cache en local. Chaque post n'est payé qu'une fois : les agents lisent le cache gratuitement.
- **Skill `write-tweet`** : charge le contexte, vérifie que tu n'as pas déjà traité le sujet, applique ta voix (ta skill `*-writing-style` si elle existe) et propose 3 brouillons argumentés par tes chiffres.
- **Extension Claude Desktop** (`x-context.mcpb`) : le même serveur, avec le formulaire de connexion natif de Claude Desktop.
- **Lecture seule** : rien n'est jamais publié.

## 1. Préparer l'accès à l'API X

Sur [console.x.com](https://console.x.com) : crée une app (ou reprends une existante), achète quelques crédits et **fixe un plafond de dépense** (quelques dollars suffisent). Dans *Keys and tokens*, récupère l'*API Key* et l'*API Key Secret*, puis génère un *Access Token* et son *Secret* pour **ton** compte (la permission Read suffit).

## 2. Installer selon l'app

| Où | Ce qui tourne | Comment renseigner les clés |
|---|---|---|
| **Claude Desktop — chat** | l'extension `.mcpb` (le chat ignore les serveurs locaux des plugins) | formulaire à l'installation de l'extension |
| **Claude Desktop — Cowork** | le serveur du plugin | outil `x_connect` (Cowork ne propose pas les réglages de plugin) |
| **Claude Code** (terminal, onglet Code) | le serveur du plugin | réglages du plugin à l'activation, ou `x_connect` |
| claude.ai web / mobile | rien : le serveur est local | — |

### Claude Desktop (chat)

1. Télécharge [`x-context.mcpb`](https://github.com/AlphaLuppi/plugin-marketplace/raw/main/plugins/x-context/dist/x-context.mcpb) et **double-clique** dessus (ou *Settings → Extensions → Advanced settings → Install Extension…*).
2. Claude Desktop affiche le formulaire : colle les 4 clés OAuth 1.0a. Elles sont masquées et rangées dans le trousseau de l'OS. Modifiables ensuite dans *Settings → Extensions → X context*.
3. Pour la skill `write-tweet` dans le chat, garde aussi le plugin installé (*Customize → Plugins*) : le chat charge ses skills, les outils viennent de l'extension.

### Plugin (Claude Code, Cowork)

```bash
/plugin marketplace add AlphaLuppi/plugin-marketplace
/plugin install x-context@alphaluppi-plugins
```

Claude Code demande les réglages à l'activation (sinon : `/plugin` → x-context → configure). Partout ailleurs, ou pour changer de compte, demande simplement à Claude de **connecter ton compte X** : l'outil `x_connect` ouvre une page locale (`127.0.0.1`, lien à usage unique, valable 15 min) où tu saisis les clés. Elles sont vérifiées auprès de X puis enregistrées sur ta machine, **sans jamais passer par la conversation**.

Ordre de priorité des clés : réglages du plugin / de l'extension, puis clés enregistrées via `x_connect`.

## 3. Utiliser

`/x-context:write-tweet un post sur <sujet>`, ou simplement « écris-moi un tweet sur … ». Au premier lancement, la skill fait un `dry_run` et te montre le coût maximal avant la vraie synchro.

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
| `x_connect` | un appel de vérification | Page locale pour saisir ou remplacer les clés |
| `x_writing_context` | gratuit | Le briefing : ta façon d'écrire, ce qui performe par format / longueur / pièce jointe / heure / jour, tes meilleurs et tes plus faibles posts, tes posts récents |
| `x_list_posts` | gratuit | Recherche, filtre et tri dans le cache (« est-ce que j'ai déjà dit ça ? ») |

**×usual** = engagement (likes + reposts + réponses + citations + bookmarks) divisé par ta médiane sur les ±45 jours autour du post. Ça neutralise la croissance de ton audience. Les métriques capturées moins de 48 h après publication sont exclues des classements jusqu'au prochain `refresh_metrics_days`.

## Données locales

Tout vit dans `~/.x-context/`, **partagé entre le plugin et l'extension** (un post n'est payé qu'une fois, où que tu l'utilises) et conservé si tu désinstalles :

- `posts.json` : le cache. Retweets ignorés ; réponses gardées mais séparées de tes posts originaux dans les analyses. Le cache de la v0.1 (dossier de données du plugin) est repris automatiquement.
- `credentials.json` : les clés saisies via `x_connect` (fichier lisible par toi seul). Les clés des réglages du plugin ou de l'extension restent, elles, dans le trousseau de l'OS.

Le réglage *Cache directory* du plugin (ou `X_CONTEXT_DATA_DIR`) change cet emplacement.

## Autres clients MCP

Le serveur est un simple MCP stdio :

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/chemin/vers/plugins/x-context/dist/server.mjs"]
    }
  }
}
```

Puis `x_connect` pour les clés, ou les variables `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (ou `X_BEARER_TOKEN` + `X_USERNAME`). Aussi : `X_TIMEZONE` (fuseau des analyses horaires, par défaut celui du système), `X_CONTEXT_DATA_DIR`, `X_API_BASE_URL`.

## Développement

```bash
cd plugins/x-context
bun install
bun run check   # tsc + bundle dist/server.mjs + bun test + pack dist/x-context.mcpb
```

`dist/server.mjs` (bundle esbuild autonome, Node ≥ 18) et `dist/x-context.mcpb` sont commités pour que le plugin et l'extension s'installent sans build. Rebuild et commit après chaque changement dans `src/`. L'icône de l'extension se régénère avec `node scripts/make-icon.mjs`.
