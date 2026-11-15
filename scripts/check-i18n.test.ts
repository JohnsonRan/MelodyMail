import { describe, expect, test } from "bun:test";
import { CannotRun, check } from "./check-i18n";

type Tree = Record<string, Record<string, string>>;

function catalogs(trees: Record<string, Tree>) {
  return new Map(
    Object.entries(trees).map(([locale, tree]) => [
      locale,
      new Map(
        Object.entries(tree).flatMap(([ns, keys]) =>
          Object.entries(keys).map(([k, v]) => [`${ns}.${k}`, v] as const),
        ),
      ),
    ]),
  );
}

const en = { common: { title: "Inbox", empty: "No mail" } };

describe("check-i18n", () => {
  test("matching catalogs pass", () => {
    expect(check(catalogs({ en, ja: { common: { title: "受信", empty: "なし" } } }))).toEqual([]);
  });

  test("a missing key is named", () => {
    expect(check(catalogs({ en, ja: { common: { title: "受信" } } }))).toEqual([
      "ja: missing common.empty",
    ]);
  });

  test("an extra key is named", () => {
    const ja = { common: { title: "受信", empty: "なし", stray: "x" } };
    expect(check(catalogs({ en, ja }))).toEqual(["ja: common.stray is not in en"]);
  });

  test("an empty value is named", () => {
    expect(check(catalogs({ en, ja: { common: { title: "受信", empty: " " } } }))).toEqual([
      "ja: common.empty is empty",
    ]);
  });

  test("scanning nothing cannot pass", () => {
    expect(() => check(catalogs({}))).toThrow(CannotRun);
    expect(() => check(catalogs({ en: {}, ja: {} }))).toThrow(CannotRun);
  });
});
