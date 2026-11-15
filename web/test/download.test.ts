import { describe, expect, test } from "bun:test";
import { safeFilename } from "../src/reader/download";

// The name an attachment is saved under comes from the sender. It must not carry a path, a
// reserved or control character, or a leading dot that hides the file.
describe("attachment file names", () => {
  test("replaces path separators, reserved and control characters", () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j.txt', "x")).toBe("a_b_c_d_e_f_g_h_i_j.txt");
    expect(safeFilename("bell\u0007tab\tnul\u0000.pdf", "x")).toBe("bell_tab_nul_.pdf");
  });

  test("drops leading and trailing dots and spaces", () => {
    expect(safeFilename("..hidden.html", "x")).toBe("hidden.html");
    expect(safeFilename(" report.pdf. ", "x")).toBe("report.pdf");
  });

  test("falls back for a missing or empty name and caps the length", () => {
    expect(safeFilename(null, "attachment")).toBe("attachment");
    expect(safeFilename("...", "attachment")).toBe("attachment");
    expect(safeFilename(`${"a".repeat(300)}.txt`, "x")).toHaveLength(150);
  });
});
