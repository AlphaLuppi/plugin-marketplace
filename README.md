# Alpha Luppi — Plugin Marketplace

Marketplace Claude Code maison. Catalogue interne de plugins (skills, agents, hooks, MCP) packagés pour distribution via `/plugin`.

## Plugins disponibles

| Plugin | Description |
|---|---|
| [`loom-monitoring`](./plugins/loom-monitoring) | Rend n'importe quelle application monitorable par Loom (contrat health/heartbeat, drift `/version.json`, enregistrement MCP). |

## Ajouter ce marketplace dans Claude Code

```bash
# depuis un clone local
/plugin marketplace add ./plugin-marketplace

# ou depuis GitHub une fois publié
/plugin marketplace add <owner>/plugin-marketplace
```

Puis installer un plugin :

```bash
/plugin install loom-monitoring@alphaluppi-plugins
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
