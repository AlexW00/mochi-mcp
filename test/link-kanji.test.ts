import assert from "node:assert/strict";
import { test } from "node:test";
import { linkKanji, WORD_JOINER as J } from "../scripts/link-kanji.js";

const kanji = new Map([["危", "k1"], ["機", "k2"], ["電", "k3"], ["話", "k4"], ["見", "k5"]]);

test("links kanji outside parentheses only", () => {
  const result = linkKanji("危 (Kanji: Gefahr) + 機 (Kanji: Gelegenheit, Maschine)", kanji);
  assert.equal(result.text, "[[危|k1]] (Kanji: Gefahr) + [[機|k2]] (Kanji: Gelegenheit, Maschine)");
  assert.deepEqual(result.linked, ["危", "機"]);
});

test("links each kanji of a compound and keeps unknown kanji as text", () => {
  const result = linkKanji("電話 (Kanji: Elektrizität + Sprache) + 意見 (見 im Klammertext)", kanji);
  assert.equal(result.text, `[[電|k3]]${J}[[話|k4]] (Kanji: Elektrizität + Sprache) + 意[[見|k5]] (見 im Klammertext)`);
  assert.deepEqual(result.missing, ["意"]);
});

test("is idempotent and ignores kana, full-width parentheses and 々", () => {
  const once = linkKanji("危々 （危） + く (Endung: Verb)", kanji).text;
  assert.equal(once, "[[危|k1]]々 （危） + く (Endung: Verb)");
  assert.equal(linkKanji(once, kanji).text, once);
});

test("keeps furigana working", () => {
  const map = new Map([["覧", "r1"], ["商", "s1"], ["品", "s2"]]);
  assert.equal(linkKanji("ご＋ 覧(らん)（見ること）", map).text, "ご＋ [[覧(らん)|r1]]（見ること）");
  assert.equal(linkKanji("新 ＋ 商品(しょうひん) (Ware)", map).text, `新 ＋ [[商|s1]]${J}[[品|s2]]（しょうひん） (Ware)`);
  assert.equal(linkKanji("意見(いけん)", map).text, "意見(いけん)");
  const once = linkKanji("覧(らん) + 商品（しょうひん）", map).text;
  assert.equal(linkKanji(once, map).text, once);
});

test("replaces single-kanji Markdown links and leaves other links alone", () => {
  const map = new Map([["縮", "c1"], ["払", "c2"]]);
  assert.equal(
    linkKanji("[縮](https://jpdb.io/kanji/%E7%B8%AE#a) shrink, [払う](https://x.y) pay, <b>払</b>", map).text,
    "[[縮|c1]] shrink, [払う](https://x.y) pay, <b>[[払|c2]]</b>",
  );
});
