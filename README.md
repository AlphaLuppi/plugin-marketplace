# Alpha Luppi — Plugin Marketplace

Marketplace Claude Code maison. Catalogue interne de plugins (skills, agents, hooks, MCP) packagés pour distribution via `/plugin`.

Repo : <https://github.com/AlphaLuppi/plugin-marketplace>

## Plugins disponibles

| Plugin | Description |
|---|---|
| [`expo-ios-testflight`](./plugins/expo-ios-testflight) | Build & ship une app Expo/React Native sur TestFlight en local (`eas build --local`) ou en CI : pièges de build Mac (fastlane, certificat, rsync), API App Store Connect (soumission, review externe, compte démo, notes, rate-limit), stamping de version, + recette de vérification en simulateur iOS. |
| [`loom-monitoring`](./plugins/loom-monitoring) | Rend n'importe quelle application monitorable par Loom (contrat health/heartbeat, drift `/version.json`, enregistrement MCP). |

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
```

Mettre à jour le marketplace plus tard :

```bash
/plugin marketplace update alphaluppi-plugins
```

## Structure du repo

```
plugin-marketplace/
├── .claude-plugin/
│   └── marketplace.json          # catalogue (nom marketplace : alphaluppi-plugins)
└── plugins/
    └── loom-monitoring/
        ├── .claude-plugin/
        │   └── plugin.json       # manifest du plugin
        └── skills/
            └── loom-monitoring/
                ├── SKILL.md
                ├── references/
                └── scripts/
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
