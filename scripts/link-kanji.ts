/**
 * Turns the kanji in a vocab field into Mochi card links, e.g.
 *   "危 (Kanji: Gefahr) + 機 (Kanji: Gelegenheit)"
 * becomes
 *   "[[危|<kanji card id>]] (Kanji: Gefahr) + [[機|<kanji card id>]] (Kanji: Gelegenheit)".
 *
 * Only kanji outside parentheses are linked, and only when a kanji card with
 * that name exists. Existing [[links]] are left alone, so the run is idempotent:
 * re-running skips finished cards without a request and resumes after an abort.
 *
 * Every request goes through the server's MochiQueue (one at a time, backoff
 * on 429). Usage (from the repo root, after `npm run build`):
 *
 *   node dist/scripts/link-kanji.js clone --deck <id> [--limit 50] [--sample]
 *   node dist/scripts/link-kanji.js link  --deck <id> [--limit 50] [--dry-run]
 *   node dist/scripts/link-kanji.js relink  --log <link-log.jsonl> [--dry-run]
 *   node dist/scripts/link-kanji.js restore --log <link-log.jsonl>
 *
 * `link` writes a full JSON backup of the deck tree and a JSONL log of every
 * change (before/after) to --out (default ./link-kanji-runs) before and while
 * writing; `restore` puts the logged "before" values back.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { expandDecks } from "../src/mochi/card-index.js";
import { MochiClient, type Card, type Deck } from "../src/mochi/client.js";
import { MochiQueue } from "../src/mochi/queue.js";

const DEFAULTS = {
  vocabTemplate: "QuKdZNTm",
  field: "oIWjf8HN", // japanese - constituents
  kanjiTemplate: "AqhLXzdn",
};

const HAN = /\p{Script=Han}/u;
export const WORD_JOINER = "\u2060";
const OPEN = new Set(["(", "（"]);
const CLOSE = new Set([")", "）"]);

// Tokens that must not be split: existing Mochi links, Markdown links, HTML tags,
// and furigana groups such as 覧(らん) or 商品（しょうひん）.
const TOKEN = new RegExp(
  [
    String.raw`(?<mochi>\[\[[^\]]*\]\])`,
    String.raw`(?<md>\[(?<label>[^\[\]]+)\]\([^)\s]+\))`,
    String.raw`(?<html><[^>]*>)`,
    String.raw`(?<base>\p{Script=Han}+)[(（](?<reading>[\p{Script=Hiragana}\p{Script=Katakana}ー・]+)[)）]`,
  ].join("|"),
  "uy",
);

/**
 * Links every kanji outside parentheses that has a card in `kanji`.
 * - Furigana: a single kanji keeps its reading inside the link (`[[覧(らん)|id]]`,
 *   which Mochi renders as ruby); a compound gets one link per kanji and the
 *   reading as plain text (`[[商|a]][[品|b]]（しょうひん）`). `[[覧|id]](らん)`
 *   would break Mochi's furigana parser.
 * - A Markdown link whose label is one kanji (`[縮](https://jpdb.io/…)`) becomes
 *   the Mochi link; other Markdown links and HTML are left untouched.
 */
export function linkKanji(text: string, kanji: Map<string, string>): { text: string; linked: string[]; missing: string[] } {
  let out = "";
  let depth = 0;
  const linked: string[] = [];
  const missing: string[] = [];
  const link = (ch: string, label = ch): string | undefined => {
    const id = kanji.get(ch);
    if (!id) {
      missing.push(ch);
      return undefined;
    }
    linked.push(ch);
    return `[[${label}|${id}]]`;
  };

  let i = 0;
  while (i < text.length) {
    TOKEN.lastIndex = i;
    const match = TOKEN.exec(text);
    if (match?.groups) {
      const { mochi, md, label, html, base, reading } = match.groups;
      if (mochi || html) {
        out += match[0];
      } else if (md) {
        const chars = [...(label ?? "")];
        out += depth === 0 && chars.length === 1 && HAN.test(chars[0]!) ? (link(chars[0]!) ?? match[0]) : match[0];
      } else if (base && reading) {
        const chars = [...base];
        if (depth > 0) {
          out += match[0];
        } else if (chars.length === 1) {
          out += link(base, `${base}(${reading})`) ?? match[0];
        } else {
          const parts = chars.map((ch) => (ch === "々" ? ch : (link(ch) ?? ch)));
          out += parts.join("") === base ? match[0] : `${parts.join("")}（${reading}）`;
        }
      }
      i += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
    out += depth === 0 && HAN.test(ch) && ch !== "々" ? (link(ch) ?? ch) : ch;
  }
  // Mochi misparses adjacent links (`]][[`); an invisible word joiner keeps them apart.
  return { text: out.replaceAll("]][[", `]]${WORD_JOINER}[[`), linked, missing };
}

function client(): MochiClient {
  const config = loadConfig();
  return new MochiClient(config.mochiApiKey, new MochiQueue(config.queue), config.mochiBaseUrl);
}

async function cardsInTree(mochi: MochiClient, rootId: string, decks: Deck[]): Promise<Card[]> {
  const cards: Card[] = [];
  for (const deckId of expandDecks([rootId], decks, true)) {
    const { docs } = await mochi.listAllCards({ deckId, maxCards: 50_000 });
    cards.push(...docs.filter((card) => !card["trashed?"]));
  }
  return cards;
}

async function kanjiMap(mochi: MochiClient, templateId: string): Promise<Map<string, string>> {
  process.stderr.write("Loading kanji cards (whole account)…\n");
  const { docs } = await mochi.listAllCards({ maxCards: 50_000 });
  const map = new Map<string, string>();
  for (const card of docs) {
    if (card["template-id"] !== templateId || card["trashed?"]) continue;
    const name = card.fields?.name?.value?.trim() ?? "";
    if ([...name].length === 1 && !map.has(name)) map.set(name, card.id);
  }
  process.stderr.write(`${map.size} kanji cards\n`);
  return map;
}

/** Evenly spaced pick, so a test covers every subdeck rather than the first page. */
function spread<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, i) => items[Math.floor((i * items.length) / limit)]!);
}

const fmt = (ms: number) => `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;

async function clone(opts: { deck: string; limit?: number; name?: string; field: string }) {
  const mochi = client();
  const decks = await mochi.listDecks();
  const root = decks.find((deck) => deck.id === opts.deck);
  if (!root) throw new Error(`Deck ${opts.deck} not found`);
  let cards = await cardsInTree(mochi, root.id, decks);
  if (opts.limit) cards = spread(cards.filter((card) => HAN.test(card.fields?.[opts.field]?.value ?? "")), opts.limit);
  const date = new Date().toISOString().slice(0, 10);
  const name = opts.name ?? `${root.name} (backup ${date}${opts.limit ? `, ${cards.length} cards` : ""})`;

  // Mirror the deck tree; archived so the copies never show up in reviews.
  const mapping = new Map<string, string>();
  const copyDeck = async (source: Deck, parentId: string | null, deckName: string) => {
    const copy = await mochi.createDeck({ name: deckName, "parent-id": parentId, "archived?": true });
    mapping.set(source.id, copy.id);
    for (const child of decks.filter((deck) => deck["parent-id"] === source.id && !deck["trashed?"])) {
      await copyDeck(child, copy.id, child.name);
    }
  };
  await copyDeck(root, root["parent-id"] ?? null, name);
  const newRoot = mapping.get(root.id)!;
  console.log(`Created deck "${name}" (${newRoot}); copying ${cards.length} cards`);

  const started = Date.now();
  let failed = 0;
  for (const [i, card] of cards.entries()) {
    try {
      await mochi.createCard({
        content: card.content ?? "",
        "deck-id": mapping.get(card["deck-id"]) ?? newRoot,
        "template-id": card["template-id"] ?? null,
        fields: card.fields,
        "manual-tags": (card["manual-tags"] ?? card.tags ?? []) as string[],
        "review-reverse?": card["review-reverse?"],
      });
    } catch (error) {
      failed += 1;
      console.error(`  ! ${card.id}: ${(error as Error).message}`);
    }
    if ((i + 1) % 25 === 0 || i + 1 === cards.length) {
      const elapsed = Date.now() - started;
      console.log(`  ${i + 1}/${cards.length} (${fmt(elapsed)}, ~${fmt((elapsed / (i + 1)) * (cards.length - i - 1))} left)`);
    }
  }
  console.log(`Done: ${cards.length - failed} copied, ${failed} failed. New deck id: ${newRoot}`);
}

async function link(opts: { deck: string; limit?: number; dryRun: boolean; out: string; field: string; vocabTemplate: string; kanjiTemplate: string }) {
  const mochi = client();
  const decks = await mochi.listDecks();
  if (!decks.some((deck) => deck.id === opts.deck)) throw new Error(`Deck ${opts.deck} not found`);
  const kanji = await kanjiMap(mochi, opts.kanjiTemplate);
  const cards = (await cardsInTree(mochi, opts.deck, decks)).filter((card) => card["template-id"] === opts.vocabTemplate);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(opts.out, { recursive: true });
  const backupPath = join(opts.out, `backup-${opts.deck}-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(cards));

  const missing = new Map<string, number>();
  let plan = cards.flatMap((card) => {
    const before = card.fields?.[opts.field]?.value ?? "";
    const result = linkKanji(before, kanji);
    for (const ch of result.missing) missing.set(ch, (missing.get(ch) ?? 0) + 1);
    return result.text === before ? [] : [{ card, before, after: result.text }];
  });
  const total = plan.length;
  if (opts.limit) plan = plan.slice(0, opts.limit);

  console.log(`${cards.length} vocab cards, ${total} need links, ${cards.length - total} already done or without kanji cards.`);
  console.log(`Kanji without a kanji card (left as text): ${missing.size} distinct` +
    (missing.size ? `, most common: ${[...missing].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([ch, n]) => `${ch}×${n}`).join(" ")}` : ""));
  console.log(`Backup of all ${cards.length} cards: ${resolve(backupPath)}`);
  for (const item of plan.slice(0, 5)) console.log(`  e.g. ${item.card.fields?.name?.value}: ${item.before}\n       → ${item.after}`);
  if (opts.dryRun) {
    console.log(`Dry run: would update ${plan.length} cards.`);
    return;
  }

  const logPath = join(opts.out, `link-${opts.deck}-${stamp}.jsonl`);
  console.log(`Updating ${plan.length} cards; log: ${resolve(logPath)}`);
  const started = Date.now();
  let failed = 0;
  for (const [i, { card, before, after }] of plan.entries()) {
    const entry = { id: card.id, name: card.fields?.name?.value, field: opts.field, before, after, status: "ok", error: undefined as string | undefined };
    try {
      // Mochi replaces the whole fields map, so send every field with only ours changed.
      await mochi.updateCard(card.id, { fields: { ...card.fields, [opts.field]: { id: opts.field, value: after } } });
    } catch (error) {
      failed += 1;
      entry.status = "failed";
      entry.error = (error as Error).message.slice(0, 300);
      console.error(`  ! ${entry.name} (${card.id}): ${entry.error}`);
    }
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
    if ((i + 1) % 25 === 0 || i + 1 === plan.length) {
      const elapsed = Date.now() - started;
      console.log(`  ${i + 1}/${plan.length} (${fmt(elapsed)}, ~${fmt((elapsed / (i + 1)) * (plan.length - i - 1))} left)`);
    }
  }
  console.log(`Done: ${plan.length - failed} updated, ${failed} failed. Re-run the same command to retry failures.`);
}

async function restore(opts: { log: string }) {
  const mochi = client();
  const entries = readFileSync(opts.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.status === "ok");
  console.log(`Restoring ${entries.length} cards from ${opts.log}`);
  let failed = 0;
  for (const [i, entry] of entries.entries()) {
    try {
      const card = await mochi.getCard(entry.id);
      if (card.fields?.[entry.field]?.value !== entry.after) {
        console.log(`  skip ${entry.name}: field changed since the run`);
        continue;
      }
      await mochi.updateCard(entry.id, { fields: { ...card.fields, [entry.field]: { id: entry.field, value: entry.before } } });
    } catch (error) {
      failed += 1;
      console.error(`  ! ${entry.name} (${entry.id}): ${(error as Error).message.slice(0, 300)}`);
    }
    if ((i + 1) % 25 === 0 || i + 1 === entries.length) console.log(`  ${i + 1}/${entries.length}`);
  }
  console.log(`Done, ${failed} failed.`);
}

async function relink(opts: { log: string; dryRun: boolean; kanjiTemplate: string }) {
  const mochi = client();
  const kanji = await kanjiMap(mochi, opts.kanjiTemplate);
  const entries = readFileSync(opts.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.status === "ok");
  const fixes = entries.map((entry) => ({ ...entry, fixed: linkKanji(entry.before, kanji).text }))
    .filter((entry) => entry.fixed !== entry.after);
  console.log(`${entries.length} logged cards, ${fixes.length} need a fix.`);
  for (const entry of fixes.slice(0, 8)) console.log(`  ${entry.name}: ${entry.after}\n     → ${entry.fixed}`);
  if (opts.dryRun) return;
  const fixLog = opts.log.replace(/\.jsonl$/, "") + `-relink-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  let failed = 0;
  for (const [i, entry] of fixes.entries()) {
    const record = { id: entry.id, name: entry.name, field: entry.field, before: entry.after, after: entry.fixed, status: "ok", error: undefined as string | undefined };
    try {
      const card = await mochi.getCard(entry.id);
      if (card.fields?.[entry.field]?.value !== entry.after) {
        record.status = "skipped";
        console.log(`  skip ${entry.name}: field changed since the run`);
      } else {
        await mochi.updateCard(entry.id, { fields: { ...card.fields, [entry.field]: { id: entry.field, value: entry.fixed } } });
      }
    } catch (error) {
      failed += 1;
      record.status = "failed";
      record.error = (error as Error).message.slice(0, 300);
      console.error(`  ! ${entry.name} (${entry.id}): ${record.error}`);
    }
    appendFileSync(fixLog, JSON.stringify(record) + "\n");
    if ((i + 1) % 25 === 0 || i + 1 === fixes.length) console.log(`  ${i + 1}/${fixes.length}`);
  }
  console.log(`Done, ${failed} failed. Log (usable with restore): ${resolve(fixLog)}`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      deck: { type: "string" },
      limit: { type: "string" },
      name: { type: "string" },
      log: { type: "string" },
      out: { type: "string", default: "link-kanji-runs" },
      "dry-run": { type: "boolean", default: false },
      field: { type: "string", default: DEFAULTS.field },
      "vocab-template": { type: "string", default: DEFAULTS.vocabTemplate },
      "kanji-template": { type: "string", default: DEFAULTS.kanjiTemplate },
    },
  });
  const limit = values.limit ? Number(values.limit) : undefined;
  const need = (value: string | undefined, flag: string) => {
    if (!value) throw new Error(`--${flag} is required`);
    return value;
  };
  switch (positionals[0]) {
    case "clone":
      return clone({ deck: need(values.deck, "deck"), limit, name: values.name, field: values.field });
    case "link":
      return link({
        deck: need(values.deck, "deck"),
        limit,
        dryRun: values["dry-run"],
        out: values.out,
        field: values.field,
        vocabTemplate: values["vocab-template"],
        kanjiTemplate: values["kanji-template"],
      });
    case "relink":
      return relink({ log: need(values.log, "log"), dryRun: values["dry-run"], kanjiTemplate: values["kanji-template"] });
    case "restore":
      return restore({ log: need(values.log, "log") });
    default:
      console.error("Usage: link-kanji.js clone|link|relink|restore … (see the header of scripts/link-kanji.ts)");
      process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(process.exitCode ?? 0), (error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
