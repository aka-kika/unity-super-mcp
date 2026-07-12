<div align="center">

<img src="https://raw.githubusercontent.com/aka-kika/unity-super-mcp/main/assets/logo.png" alt="Unity Super MCP" width="120" />

# Unity Super MCP

**One MCP server for Unity Gaming Services LiveOps, build-size analysis, and store compliance.**

[![License: MIT](https://img.shields.io/badge/License-MIT-a855f7.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](server.ts)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-15_tools-111111)](https://modelcontextprotocol.io)
[![Unity](https://img.shields.io/badge/Unity-UGS-000000?logo=unity&logoColor=white)](https://unity.com/solutions/gaming-services)

<img src="https://raw.githubusercontent.com/aka-kika/unity-super-mcp/main/assets/demo.gif" alt="Unity Super MCP demo" width="700" />

</div>

An MCP server that gives an AI agent 15 tools over a Unity project: Unity Gaming Services LiveOps (Economy, Cloud Save, Cloud Code), build-size and bloat analysis, and store-compliance checks — one install instead of four.

> **Why this exists (read me first).** This was built in a single sitting to win a bet — whether an agent could usefully drive UGS end-to-end. This is the receipt. I build MCP servers and agent infrastructure; I am not a game developer and this is not a pivot into games. It's here as a demonstration of MCP tool design, not a maintained product.

Built entirely through a text-only chat with a mobile AI assistant (no file uploads, no IDE), then verified: the server type-checks clean and boots. Treat it as a reference implementation.

## Install

```bash
npx -y unity-super-mcp
```

<details>
<summary><b>Client config</b> — Claude / Cursor / Windsurf</summary>

```json
{
  "mcpServers": {
    "unity-super": {
      "command": "npx",
      "args": ["-y", "unity-super-mcp"],
      "env": {
        "UNITY_PROJECT_PATH": "/path/to/MyGame",
        "UNITY_PROJECT_ID": "your-project-id",
        "UNITY_SERVICE_KEY_ID": "your-key-id",
        "UNITY_SERVICE_SECRET": "your-secret",
        "UNITY_ENV_ID": "production"
      }
    }
  }
}
```

</details>

No UGS credentials? Set only `UNITY_PROJECT_PATH` and you still get the 7 build/compliance tools. The UGS tools report "not configured" instead of failing.

## Tools

### 🎮 UGS LiveOps (8)

| Tool | What it does |
|---|---|
| `ugs_get_project_info` | Project + environment readout |
| `economy_list_catalog` | List currencies, items, purchases |
| `economy_create_currency` | Create a currency |
| `economy_create_item` | Create an inventory item |
| `economy_create_shop` | Create a shop with items and costs |
| `cloudsave_get_player_data` | Read a player's Cloud Save data |
| `cloudcode_list_modules` | List deployed Cloud Code modules |
| `cloudcode_deploy_module` | Deploy a Cloud Code module |

### 📦 Build & Ship (7)

| Tool | What it does |
|---|---|
| `super_health_check` | **Run this first** — fans the core checks out in parallel, returns a summary + next actions |
| `build_get_last_report` | Top largest assets, size by extension, total project size |
| `build_analyze_bloat` | Duplicates, oversized files, `Resources/` abuse, unoptimized textures |
| `build_fix_imports` | Generates a C# editor script for texture-import fixes (or edits `.meta` directly with `apply=true`) |
| `assets_find_orphans` | Unreferenced-asset heuristic |
| `build_check_compliance` | Android target SDK, iOS, StreamingAssets bloat |

## Notes

- `super_health_check` is the intended entry point: one call, whole-project readout.
- `assets_find_orphans` is heuristic — verify with `AssetDatabase.GetDependencies` before deleting anything.
- Requires Node 18+.

## License

MIT. Do what you like with it.
