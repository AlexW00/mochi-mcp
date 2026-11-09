import assert from "node:assert/strict";
import { test } from "node:test";
import { linkKanji } from "../scripts/link-kanji.js";

const kanji = new Map([["危", "k1"], ["機", "k2"], ["電", "k3"], ["話", "k4"], ["見", "k5"]]);

test("links kanji outside parentheses only", () => {
  const result = linkKanji("危 (Kanji: Gefahr) + 機 (Kanji: Gelegenheit, Maschine)", kanji);
  assert.equal(result.text, "[[危|k1]] (Kanji: Gefahr) + [[機|k2]] (Kanji: Gelegenheit, Maschine)");
  assert.deepEqual(result.linked, ["危", "機"]);
});

test("links each kanji of a compound and keeps unknown kanji as text", () => {
  const result = linkKanji("電話 (Kanji: Elektrizität + Sprache) + 意見 (見 im Klammertext)", kanji);
  assert.equal(result.text, "[[電|k3]][[話|k4]] (Kanji: Elektrizität + Sprache) + 意[[見|k5]] (見 im Klammertext)");
  assert.deepEqual(result.missing, ["意"]);
});

test("is idempotent and ignores kana, full-width parentheses and 々", () => {
  const once = linkKanji("危々 （危） + く (Endung: Verb)", kanji).text;
  assert.equal(once, "[[危|k1]]々 （危） + く (Endung: Verb)");
  assert.equal(linkKanji(once, kanji).text, once);
});
