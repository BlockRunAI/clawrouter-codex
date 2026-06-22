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

// Normalize a dashed version to a dotted one so "claude-opus-4-7" and
// "claude-opus-4.7" collapse to one canonical slug (and one clean name).
function normSlug(id) {
  return id.replace(/(\d)-(\d)/g, "$1.$2");
}

const WORD_CASE = {
  gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", minimax: "MiniMax", kimi: "Kimi",
  qwen: "Qwen", nemotron: "Nemotron", mistral: "Mistral", llama: "Llama", grok: "Grok",
  gemini: "Gemini", claude: "Claude", devstral: "Devstral", oss: "OSS", omni: "Omni",
};

function prettyName(id) {
  if (id === "auto" || id === "blockrun/auto") return "ClawRouter Auto (smart routing)";
  const norm = normSlug(id);
  const [prov, ...rest] = norm.split("/");
  let tail = rest.join("/") || prov;
  let titled = tail
    .replace(/[-_]/g, " ") // keep the version DOT; only dashes/underscores become spaces
    .split(" ")
    .map((w) => WORD_CASE[w.toLowerCase()] ?? (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  // The free tier and NVIDIA-hosted catalog mirror canonical models — tag the
  // source so they're distinguishable from the first-party entry.
  if (prov === "free") titled += " (free)";
  else if (prov === "nvidia") titled += " (NVIDIA)";
  return titled;
}

/** Parse a slug into {family, line, version} for de-duping + latest-N selection. */
function parseModel(id) {
  const norm = normSlug(id);
  const family = norm.split("/")[0];
  const tail = norm.split("/").slice(1).join("/") || norm;
  // version = the last dotted/whole number in the tail (4.7, 5.5, 2.5, 3.1, 120)
  const vmatch = tail.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  const version = vmatch ? parseFloat(vmatch[1]) : 0;
  // line = the tail with its trailing version token stripped (groups versions of
  // the same model series together, e.g. claude-opus-4.7 / -4.6 → "claude-opus")
  const line = tail.replace(/[-.]?\d+(?:\.\d+)?(?:-?[a-z]+\d*)?$/i, "").replace(/[-.]$/, "") || tail;
  return { slug: norm, family, line: `${family}/${line}`, version };
}

async function main() {
  const template = JSON.parse(await readFile(join(__dirname, "_model_template.json"), "utf8"));

  const res = await fetch(`${proxy}/models`);
  if (!res.ok) throw new Error(`GET ${proxy}/models failed: ${res.status}`);
  const list = await res.json();
  const all = (Array.isArray(list?.data) ? list.data : []).map((m) => m.id).filter(Boolean);
  const perSeries = Number(arg("--per-series", process.env.PER_SERIES ?? "3"));
  // NVIDIA-hosted models mirror the free tier — drop them so each open model
  // appears once (as the free entry). Add families here to hide them.
  const DROP_FAMILIES = new Set((process.env.DROP_FAMILIES ?? "nvidia").split(",").filter(Boolean));

  // Canonical "provider/model" slugs; drop bare aliases (no digit in the tail,
  // e.g. anthropic/claude, openai/gpt), media-gen models, and dropped families.
  const canonical = all.filter((id) => {
    const [fam, ...rest] = id.split("/");
    const tail = rest.join("/");
    return tail && /\d/.test(tail) && !MEDIA.test(id) && !DROP_FAMILIES.has(fam);
  });

  // Group by model SERIES (version stripped), de-dup dashed/dotted spellings,
  // then keep the latest `perSeries` versions of each series. So Claude Opus
  // keeps 4.7/4.6/4.5 and GPT-5 keeps 5.5/5.4/5.3.
  const series = new Map();
  const seen = new Set();
  for (const id of canonical) {
    const m = parseModel(id);
    if (seen.has(m.slug)) continue; // normalized-slug dedup
    seen.add(m.slug);
    if (!series.has(m.line)) series.set(m.line, []);
    series.get(m.line).push(m);
  }
  const picked = [];
  for (const arr of series.values()) {
    arr.sort((a, b) => b.version - a.version);
    picked.push(...arr.slice(0, perSeries));
  }
  picked.sort((a, b) => a.family.localeCompare(b.family) || b.version - a.version);

  const ids = ["blockrun/auto", ...picked.map((m) => m.slug)];
  if (ids.length === 0) throw new Error(`no usable models from ${proxy}/models`);

  const models = ids.map((id, i) => ({
    ...structuredClone(template),
    slug: id,
    display_name: prettyName(id),
    description: `Routed through ClawRouter (${id})`,
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
