#!/usr/bin/env node
// gen-catalog — produce a Codex `model_catalog_json` from the LIVE BlockRun
// gateway model list (via the local proxy's /v1/models), so the Codex model
// picker shows every current model — GPT, Claude, Gemini, DeepSeek, Kimi, Qwen,
// Grok, GLM, MiniMax, Nemotron, plus free tiers and the smart-routing profiles.
//
//   node src/gen-catalog.mjs [--proxy http://localhost:8403/v1] [--out ~/.codex/clawrouter-catalog.json]
//
// Each Codex catalog entry needs ~28 schema fields; we clone a known-valid
// template (src/_model_template.json, native-only speed/service-tier fields
// already stripped) and override slug/display_name/description per model.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const proxy = arg("--proxy", process.env.CLAWROUTER_PROXY_URL ?? "http://localhost:8403/v1");
const out = arg("--out", join(homedir(), ".codex", "clawrouter-catalog.json")).replace(/^~/, homedir());

// Image/video generation families are useless to a coding agent — hide them.
const MEDIA = /(?:^|[/_-])(?:image|video|dall-?e|imagen|sora|veo|flux|kling|seedance|hailuo|stable-diffusion|sdxl|midjourney|nano-banana)(?:[/_-]|$|\d)/i;

// Keep the one canonical smart-routing profile; drop the other bare aliases
// (sonnet/opus/gpt/kimi/…) and routing duplicates so the picker isn't cluttered.
const KEEP_ALIASES = new Set(["auto", "blockrun/auto"]);

const FAMILY_LABEL = {
  openai: "", anthropic: "", google: "", deepseek: "DeepSeek", moonshot: "",
  nvidia: "NVIDIA", xai: "xAI", minimax: "MiniMax", zai: "", free: "",
};

function prettyName(id) {
  if (id === "auto" || id === "blockrun/auto") return "BlockRun Auto (smart routing)";
  const [prov, ...rest] = id.split("/");
  const tail = rest.join("/") || prov;
  const titled = tail
    .replace(/[-_]/g, " ")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\bglm\b/gi, "GLM")
    .replace(/\bv(\d)/gi, "V$1")
    .replace(/\bk(\d)/gi, "K$1")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const label = FAMILY_LABEL[prov];
  return label ? `${titled} · ${label}` : titled;
}

async function main() {
  const template = JSON.parse(await readFile(join(__dirname, "_model_template.json"), "utf8"));

  const res = await fetch(`${proxy}/models`);
  if (!res.ok) throw new Error(`GET ${proxy}/models failed: ${res.status}`);
  const list = await res.json();
  const all = (Array.isArray(list?.data) ? list.data : []).map((m) => m.id).filter(Boolean);

  // Canonical "provider/model" slugs + the kept routing profile; drop bare
  // aliases, routing dups, and media-generation models.
  const ids = all.filter(
    (id) => (id.includes("/") || KEEP_ALIASES.has(id)) && !MEDIA.test(id),
  );
  // blockrun/auto first, then group by family for a tidy picker.
  ids.sort((a, b) => {
    const ax = KEEP_ALIASES.has(a) ? 0 : 1, bx = KEEP_ALIASES.has(b) ? 0 : 1;
    return ax - bx || a.localeCompare(b);
  });
  if (ids.length === 0) throw new Error(`no usable models from ${proxy}/models`);

  const models = ids.map((id, i) => ({
    ...structuredClone(template),
    slug: id === "auto" ? "blockrun/auto" : id,
    display_name: prettyName(id),
    description: `Routed through BlockRun / ClawRouter (${id})`,
    visibility: "list",
    priority: i,
    service_tiers: [],
    additional_speed_tiers: [],
  }));

  const catalog = { base_instructions: template.base_instructions, models };
  await writeFile(out, JSON.stringify(catalog, null, 2));
  console.log(`[gen-catalog] wrote ${models.length} models (incl. GPT) → ${out}`);
  console.log(`[gen-catalog] config.toml:  model_catalog_json = "${out}"`);
}

main().catch((err) => {
  console.error(`[gen-catalog] ${err.message}`);
  process.exit(1);
});
