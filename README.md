# Alpha Luppi — Plugin Marketplace

Marketplace Claude Code maison. Catalogue interne de plugins (skills, agents, hooks, MCP) packagés pour distribution via `/plugin`.

Repo : <https://github.com/AlphaLuppi/plugin-marketplace>

## Plugins disponibles

| Plugin | Description |
|---|---|
| [`expo-ios-testflight`](./plugins/expo-ios-testflight) | Build & ship une app Expo/React Native sur TestFlight en local (`eas build --local`) ou en CI : pièges de build Mac (fastlane, certificat, rsync), API App Store Connect (soumission, review externe, compte démo, notes, rate-limit), stamping de version, + recette de vérification en simulateur iOS. |
| [`loom-monitoring`](./plugins/loom-monitoring) | Rend n'importe quelle application monitorable par Loom (contrat health/heartbeat, drift `/version.json`, enregistrement MCP). |
| [`x-context`](./plugins/x-context) | Tes posts X et leurs métriques (API X officielle, cache local) comme contexte pour écrire les suivants. Serveur MCP + skill `write-tweet`. Lecture seule. |

## Ajouter ce marketplace dans Claude Code

```bash
# depuis GitHub (recommandé)
/plugin marketplace add AlphaLuppi/plugin-marketplace

# ou depuis un clone local
/plugin marketplace add ./plugin-marketplace
```

Puis installer un plugin :

```bash
/plugin install loom-monitoring@alphaluppi-plugins
/plugin install x-context@alphaluppi-plugins
```

Mettre à jour le marketplace plus tard :

```bash
/plugin marketplace update alphaluppi-plugins
```

## Structure du repo

```
plugin-marketplace/
├── .claude-plugin/
│   └── marketplace.json              # catalogue (nom marketplace : alphaluppi-plugins)
├── docs/superpowers/plans/           # plans de conception
└── plugins/
    ├── loom-monitoring/
    │   ├── .claude-plugin/plugin.json    # manifest du plugin
    │   └── skills/loom-monitoring/
    │       ├── SKILL.md
    │       ├── references/
    │       └── scripts/
    └── x-context/
        ├── .claude-plugin/plugin.json    # userConfig (clés X masquées) + serveur MCP
        ├── dist/server.mjs               # bundle MCP autonome (commité)
        ├── src/ · tests/                 # sources TypeScript + bun test
        └── skills/write-tweet/SKILL.md
```

## Validation locale

```bash
claude plugin validate .
```

## Ajouter un nouveau plugin

1. Créer `plugins/<nom>/.claude-plugin/plugin.json`
2. Placer les composants dans `plugins/<nom>/skills/`, `agents/`, `commands/`, `hooks/`, etc.
3. Ajouter une entrée dans `.claude-plugin/marketplace.json` sous `plugins`
4. `claude plugin validate .` puis commit
