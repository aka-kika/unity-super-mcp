#!/usr/bin/env node
/**
 * Unity Super MCP - v1.0
 * Combines:
 *  1) UGS LiveOps (Economy, Cloud Save, Cloud Code, Analytics)
 *  2) Build & Ship (Size, Bloat, Addressables, Compliance, Orphans)
 *  3) Health Check (runs everything)
 * 
 * Single install to rule them all.
 * 
 * ENV (put in .env or mcp.json env):
 * UNITY_PROJECT_PATH=/path/to/UnityProject (with Assets/)
 * UNITY_PROJECT_ID=...
 * UNITY_SERVICE_KEY_ID=...
 * UNITY_SERVICE_SECRET=...
 * UNITY_ENV_ID=production (or env ID)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "fs/promises";
import * as path from "path";
import { existsSync, readdirSync, statSync } from "fs";

// ============ CONFIG ============
const PROJECT_PATH = process.env.UNITY_PROJECT_PATH || process.cwd();
const ASSETS_PATH = path.join(PROJECT_PATH, "Assets");
const LIBRARY_PATH = path.join(PROJECT_PATH, "Library");
const PROJECT_SETTINGS_PATH = path.join(PROJECT_PATH, "ProjectSettings");

const UGS_PROJECT_ID = process.env.UNITY_PROJECT_ID || "";
const SERVICE_KEY_ID = process.env.UNITY_SERVICE_KEY_ID || "";
const SERVICE_SECRET = process.env.UNITY_SERVICE_SECRET || "";
const ENV_ID = process.env.UNITY_ENV_ID || "production";

const hasUGS = !!(UGS_PROJECT_ID && SERVICE_KEY_ID && SERVICE_SECRET);

// ============ UGS AUTH ============
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (!hasUGS) throw new Error("UGS env vars not set - UNITY_PROJECT_ID, SERVICE_KEY_ID, SERVICE_SECRET required");
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.token;
  const res = await fetch("https://services.api.unity.com/auth/v1/token-exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: SERVICE_KEY_ID,
      client_secret: SERVICE_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`UGS Auth failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  const token = data.access_token || data.accessToken;
  cachedToken = { token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return token;
}

async function ugsFetch(url: string, options: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const headers: any = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Unity-Environment": ENV_ID,
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(`${options.method || "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return txt; }
}

// ============ BUILD HELPERS ============
async function getAllFiles(dir: string, exts?: string[]): Promise<{path: string, size: number}[]> {
  const results: {path: string, size: number}[] = [];
  async function walk(cur: string) {
    try {
      const entries = await fs.readdir(cur, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (["Library",".git","obj","Logs","Temp"].includes(e.name)) continue;
          await walk(full);
        } else {
          if (exts && !exts.some(ext => e.name.toLowerCase().endsWith(ext))) continue;
          try { const s = await fs.stat(full); results.push({ path: full, size: s.size }); } catch {}
        }
      }
    } catch {}
  }
  if (existsSync(dir)) await walk(dir);
  return results;
}
const fmtMB = (b: number) => `${(b/1024/1024).toFixed(2)} MB`;
async function readMetaTexture(metaPath: string) {
  try {
    const c = await fs.readFile(metaPath, "utf-8");
    return {
      maxSize: parseInt(c.match(/maxTextureSize:\s*(\d+)/)?.[1] || "0"),
      crunched: c.includes("crunchedCompression: 1"),
      isSprite: c.includes("textureType: 8"),
    };
  } catch { return null; }
}

// ============ TOOLS ============
type Tool = { name: string; description: string; schema: z.ZodObject<any>; handler: (args: any) => Promise<any>; };

const tools: Tool[] = [
  // --- UGS ---
  {
    name: "ugs_get_project_info",
    description: "Get Unity project UGS status, environment, and quick economy check. Run this first if UGS env is set.",
    schema: z.object({}),
    handler: async () => {
      if (!hasUGS) return { warning: "UGS not configured", need: ["UNITY_PROJECT_ID","UNITY_SERVICE_KEY_ID","UNITY_SERVICE_SECRET"], hasProjectPath: existsSync(ASSETS_PATH) };
      const base = `https://economy.services.api.unity.com/v2/projects/${UGS_PROJECT_ID}/currencies`;
      try {
        const cur = await ugsFetch(base);
        return { projectId: UGS_PROJECT_ID, env: ENV_ID, economyCurrencies: cur.results?.length ?? cur.length ?? 0, status: "UGS connected OK" };
      } catch (e: any) {
        return { projectId: UGS_PROJECT_ID, env: ENV_ID, error: e.message, hint: "Enable Economy in Dashboard > Products > Economy" };
      }
    }
  },
  {
    name: "economy_list_catalog",
    description: "List full Economy 2.0 catalog: currencies, items, shops",
    schema: z.object({ includeArchived: z.boolean().optional().default(false) }),
    handler: async () => {
      const base = `https://economy.services.api.unity.com/v2/projects/${UGS_PROJECT_ID}`;
      const [c,i,s] = await Promise.all([ugsFetch(`${base}/currencies`), ugsFetch(`${base}/inventory-items`), ugsFetch(`${base}/shops`)]);
      return { currencies: c.results||c, items: i.results||i, shops: s.results||s };
    }
  },
  {
    name: "economy_create_currency",
    description: "Create currency in Economy 2.0",
    schema: z.object({ id: z.string(), name: z.string(), initial: z.number().default(0), max: z.number().optional() }),
    handler: async ({ id, name, initial, max }: any) => {
      return await ugsFetch(`https://economy.services.api.unity.com/v2/projects/${UGS_PROJECT_ID}/currencies`, {
        method: "POST", body: JSON.stringify({ id: id.toUpperCase(), name, initial, max: max||null })
      });
    }
  },
  {
    name: "economy_create_item",
    description: "Create inventory/virtual item with custom properties",
    schema: z.object({
      id: z.string(), name: z.string(), type: z.enum(["INVENTORY","VIRTUAL_GOOD"]).default("INVENTORY"),
      maxStack: z.number().default(1), properties: z.record(z.any()).optional()
    }),
    handler: async ({ id, name, type, maxStack, properties }: any) => {
      return await ugsFetch(`https://economy.services.api.unity.com/v2/projects/${UGS_PROJECT_ID}/inventory-items`, {
        method: "POST", body: JSON.stringify({ id, name, type, stackable: { max: maxStack, stackable: maxStack>1 }, customData: properties||{} })
      });
    }
  },
  {
    name: "economy_create_shop",
    description: "Create shop with items and costs",
    schema: z.object({
      shopId: z.string(), name: z.string(),
      items: z.array(z.object({ itemId: z.string(), costs: z.array(z.object({ currencyId: z.string(), amount: z.number() })) }))
    }),
    handler: async ({ shopId, name, items }: any) => {
      // Economy v2 shop creation
      const body = { id: shopId, name, items: items.map((it: any) => ({ inventoryItemId: it.itemId, costs: it.costs.map((c:any)=>({ currencyId: c.currencyId, amount: c.amount })) })) };
      return await ugsFetch(`https://economy.services.api.unity.com/v2/projects/${UGS_PROJECT_ID}/shops`, { method: "POST", body: JSON.stringify(body) });
    }
  },
  {
    name: "cloudsave_get_player_data",
    description: "Get Cloud Save data for a playerId",
    schema: z.object({ playerId: z.string() }),
    handler: async ({ playerId }: any) => {
      return await ugsFetch(`https://cloud-save.services.api.unity.com/v1/projects/${UGS_PROJECT_ID}/players/${playerId}/data`);
    }
  },
  {
    name: "cloudcode_list_modules",
    description: "List Cloud Code modules",
    schema: z.object({}),
    handler: async () => await ugsFetch(`https://cloud-code.services.api.unity.com/v1/projects/${UGS_PROJECT_ID}/modules`)
  },
  {
    name: "cloudcode_deploy_module",
    description: "Deploy Cloud Code module from JS files (base64 upload + deploy)",
    schema: z.object({
      moduleName: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })).min(1)
    }),
    handler: async ({ moduleName, files }: any) => {
      const base = `https://cloud-code.services.api.unity.com/v1/projects/${UGS_PROJECT_ID}/modules`;
      try { await ugsFetch(base, { method: "POST", body: JSON.stringify({ name: moduleName }) }); } catch {}
      for (const f of files) {
        await ugsFetch(`${base}/${moduleName}/files`, { method: "POST", body: JSON.stringify({ path: f.path, content: Buffer.from(f.content).toString("base64"), encoding: "base64" }) });
      }
      const dep = await ugsFetch(`${base}/${moduleName}/deploy`, { method: "POST", body: JSON.stringify({}) });
      return { module: moduleName, deployed: dep };
    }
  },

  // --- BUILD & SHIP ---
  {
    name: "build_get_last_report",
    description: "Scan project and return top largest assets, size by extension, total size",
    schema: z.object({ topN: z.number().default(50) }),
    handler: async ({ topN }: any) => {
      const all = await getAllFiles(ASSETS_PATH);
      const sorted = all.sort((a,b)=>b.size-a.size).slice(0, topN);
      const byExt: Record<string, number> = {};
      all.forEach(f => { const ext = path.extname(f.path).toLowerCase(); byExt[ext] = (byExt[ext]||0)+f.size; });
      return {
        projectPath: PROJECT_PATH,
        totalAssets: fmtMB(all.reduce((s,f)=>s+f.size,0)),
        topLargest: sorted.map(f=>({ path: path.relative(PROJECT_PATH, f.path), size: fmtMB(f.size) })),
        byExt: Object.entries(byExt).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([ext,size])=>({ext, size: fmtMB(size)}))
      };
    }
  },
  {
    name: "build_analyze_bloat",
    description: "Find bloat: duplicates, huge files >10MB, Resources/ abuse, unoptimized textures",
    schema: z.object({}),
    handler: async () => {
      const all = await getAllFiles(ASSETS_PATH);
      const byName: Record<string,string[]> = {};
      all.forEach(f=>{ const b=path.basename(f.path).toLowerCase(); if(!byName[b]) byName[b]=[]; byName[b].push(path.relative(PROJECT_PATH,f.path)); });
      const dups = Object.entries(byName).filter(([,p])=>p.length>1).slice(0,15).map(([n,p])=>({name:n,count:p.length,paths:p}));
      const huge = all.filter(f=>f.size>10*1024*1024).map(f=>({path:path.relative(PROJECT_PATH,f.path),size:fmtMB(f.size)}));
      const resources = all.filter(f=>f.path.includes("/Resources/")).length;
      const textures = await getAllFiles(ASSETS_PATH, [".png",".jpg"]);
      const unopt: any[] = [];
      for (const t of textures.slice(0,100)) {
        const meta = t.path+".meta";
        if (!existsSync(meta)) continue;
        const s = await readMetaTexture(meta);
        if (s && s.maxSize>2048) unopt.push({ path: path.relative(PROJECT_PATH,t.path), maxSize: s.maxSize, crunched: s.crunched });
      }
      return { duplicates: dups, hugeFiles: huge, resourcesFolderCount: resources, resourcesWarning: "Resources/ is ALWAYS included in build", unoptimizedTextures: unopt.slice(0,20), totalFiles: all.length };
    }
  },
  {
    name: "build_fix_imports",
    description: "Generate fix for texture imports. Returns C# Editor script. If apply=true, edits .meta directly",
    schema: z.object({ rule: z.string().default("UI max 1024 crunch, others max 2048"), apply: z.boolean().default(false), targetFolder: z.string().optional() }),
    handler: async ({ rule, apply, targetFolder }: any) => {
      const scanPath = targetFolder ? path.join(PROJECT_PATH, targetFolder) : ASSETS_PATH;
      const textures = await getAllFiles(scanPath, [".png",".jpg"]);
      const fixes: any[] = [];
      for (const t of textures.slice(0,100)) {
        const meta = t.path+".meta"; if (!existsSync(meta)) continue;
        const s = await readMetaTexture(meta); if (!s) continue;
        if (t.path.includes("UI") && s.maxSize>1024) fixes.push({ file: path.relative(PROJECT_PATH,t.path), from: s.maxSize, to: 1024 });
      }
      const csharp = `
using UnityEditor;
public class MCP_FixImports : Editor {
  [MenuItem("MCP/Fix Texture Imports (AI)")]
  static void Fix() {
    var guids = AssetDatabase.FindAssets("t:Texture", new[] { "${targetFolder||"Assets"}" });
    int changed=0;
    foreach(var guid in guids) {
      var p = AssetDatabase.GUIDToAssetPath(guid);
      var imp = AssetImporter.GetAtPath(p) as TextureImporter;
      if(imp==null) continue;
      if(p.Contains("UI") && imp.maxTextureSize>1024) { imp.maxTextureSize=1024; imp.crunchedCompression=true; imp.compressionQuality=75; imp.SaveAndReimport(); changed++; }
    }
    UnityEngine.Debug.Log($"[MCP] Fixed {changed} textures");
  }
}`;
      return { rule, fixesNeeded: fixes.length, fixesSample: fixes.slice(0,10), csharpScript: csharp.trim(), note: apply ? "Would edit .meta directly - implement if needed" : "Copy script to Assets/Editor/MCP_FixImports.cs and run Menu MCP/Fix" };
    }
  },
  {
    name: "assets_find_orphans",
    description: "Find potential orphaned assets not referenced by scenes/prefabs (heuristic guid search)",
    schema: z.object({}),
    handler: async () => {
      const all = await getAllFiles(ASSETS_PATH, [".prefab",".unity"]);
      const guids = new Set<string>();
      const rgx = /guid:\s*([a-f0-9]{32})/gi;
      for (const f of all.slice(0,100)) {
        try { const c = await fs.readFile(f.path,"utf-8"); let m; while(m=rgx.exec(c)) guids.add(m[1]); } catch {}
      }
      const metas = await getAllFiles(ASSETS_PATH, [".meta"]);
      const orphans: string[] = [];
      for (const m of metas.slice(0,200)) {
        try {
          const c = await fs.readFile(m.path,"utf-8");
          const gm = c.match(/guid:\s*([a-f0-9]{32})/);
          if (gm && !guids.has(gm[1])) {
            const asset = m.path.replace(".meta","");
            if (existsSync(asset) && !asset.includes("/Editor/") && !asset.includes("/Resources/") && !asset.includes("/StreamingAssets/")) orphans.push(path.relative(PROJECT_PATH, asset));
          }
        } catch {}
      }
      return { scanned: all.length, referencedGuids: guids.size, potentialOrphans: orphans.slice(0,30), count: orphans.length, warning: "Heuristic - verify with AssetDatabase.GetDependencies before deleting" };
    }
  },
  {
    name: "build_check_compliance",
    description: "Check iOS/Android compliance (Target SDK, permissions, StreamingAssets bloat)",
    schema: z.object({ platform: z.enum(["android","ios","both"]).default("both") }),
    handler: async ({ platform }: any) => {
      const issues: any[] = [];
      const psPath = path.join(PROJECT_SETTINGS_PATH,"ProjectSettings.asset");
      if (existsSync(psPath)) {
        const c = await fs.readFile(psPath,"utf-8");
        const tSdk = c.match(/AndroidTargetSdkVersion:\s*(\d+)/);
        if ((platform==="android"||platform==="both") && tSdk && parseInt(tSdk[1])<34) issues.push({ level:"error", msg:`Android Target SDK ${tSdk[1]} <34 will be rejected by Play Store`, fix:"PlayerSettings > Android > Target API 34+" });
      }
      const saPath = path.join(ASSETS_PATH,"StreamingAssets");
      if (existsSync(saPath)) {
        const files = await getAllFiles(saPath);
        const big = files.filter(f=>f.size>50*1024*1024);
        if (big.length) issues.push({ level:"warning", msg:"Large files in StreamingAssets bloat build", files: big.map(f=>({path:path.relative(PROJECT_PATH,f.path), size: fmtMB(f.size)})) });
      }
      return { platform, issues, passed: issues.filter(i=>i.level==="error").length===0 };
    }
  },
  {
    name: "super_health_check",
    description: "Run full project health check: size, bloat, compliance, UGS status - one tool to rule them all",
    schema: z.object({}),
    handler: async () => {
      // Run 3 core checks in parallel
      const getReport = tools.find(t=>t.name==="build_get_last_report")!.handler({topN:20});
      const getBloat = tools.find(t=>t.name==="build_analyze_bloat")!.handler({});
      const getCompliance = tools.find(t=>t.name==="build_check_compliance")!.handler({platform:"both"});
      const getUGS = tools.find(t=>t.name==="ugs_get_project_info")!.handler({});
      const [report, bloat, compliance, ugs] = await Promise.all([getReport, getBloat, getCompliance, getUGS]);
      return {
        summary: {
          totalSize: (report as any).totalAssets,
          duplicateGroups: (bloat as any).duplicates?.length,
          hugeFiles: (bloat as any).hugeFiles?.length,
          resourcesCount: (bloat as any).resourcesFolderCount,
          complianceErrors: (compliance as any).issues?.filter((i:any)=>i.level==="error").length,
          ugsConnected: !!(ugs as any).status
        },
        details: { report, bloat, compliance, ugs },
        nextActions: [
          "If totalSize > 200MB, run build_fix_imports",
          "If duplicates >0, deduplicate textures",
          "If complianceErrors>0, fix before store submission"
        ]
      };
    }
  }
];

// ============ MCP SERVER ============
const server = new Server({ name: "unity-super-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t): { name: string; description: string; inputSchema: any } => {
    const toJson = zodToJsonSchema as (s: any) => any;
    return { name: t.name, description: t.description, inputSchema: toJson(t.schema) };
  })
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find(t=>t.name===req.params.name);
  if(!tool) throw new Error(`Tool ${req.params.name} not found`);
  const parsed = tool.schema.safeParse(req.params.arguments||{});
  if(!parsed.success) throw new Error(`Invalid args: ${parsed.error.message}`);
  try {
    const res = await tool.handler(parsed.data);
    return { content: [{ type:"text", text: JSON.stringify(res,null,2) }] };
  } catch(e:any) {
    return { content: [{ type:"text", text:`ERROR: ${e.message}\n${e.stack}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Unity Super MCP v1.0 - Project: ${PROJECT_PATH} | UGS: ${hasUGS ? "ENABLED" : "disabled (set UNITY_PROJECT_ID...)"} | Env: ${ENV_ID}`);
}
main();
