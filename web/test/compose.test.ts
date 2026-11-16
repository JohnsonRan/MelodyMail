import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { StubApp } from "./stub-app";

// Sending end to end through the built app (docs/M5-sending.md, "Proof"): compose, chips,
// attachments, autosave, the Markdown request, replies with their source, a failed send and
// Retry, quota states, the Sent and Drafts folders and the shortcuts, against stub-send.ts.

let app: StubApp;
let session: Session | null = null;

beforeAll(() => {
  app = new StubApp();
});

beforeEach(async () => {
  app.reset();
  await session?.page.close();
  session = null;
});

afterAll(async () => {
  await session?.page.close();
  await shutdown();
  await app.stop();
});

async function open(path = "/", width = 1280): Promise<Session> {
  session = await openSession(app.origin, path);
  await session.page.setViewportSize({ width, height: 900 });
  await session.page.locator(`[data-message-row="note3"], [data-compose]`).first().waitFor();
  return session;
}

const compose = (s: Session) => s.page.locator("[data-compose]");

async function addRecipient(s: Session, label: string, address: string) {
  const field = compose(s).getByRole("combobox", { name: label });
  await field.fill(address);
  await field.press("Enter");
  await compose(s).getByText(address, { exact: true }).waitFor();
}

describe("compose end to end", () => {
  test("composes with chips and an attachment and sends once on a double click", async () => {
    const s = await open();
    await s.page.keyboard.press("c");
    await compose(s).waitFor();
    for (const field of [
      compose(s).getByLabel("Subject"),
      compose(s).locator("textarea"),
      compose(s).getByRole("combobox", { name: "To" }),
    ]) {
      expect(await field.first().evaluate((el) => getComputedStyle(el).userSelect)).toBe("text");
    }
    await addRecipient(s, "To", "friend@example.org");
    // Not an address: refused and named.
    const to = compose(s).getByRole("combobox", { name: "To" });
    await to.fill("nope");
    await to.press("Enter");
    await compose(s).getByText("Not an email address: nope").waitFor();
    await compose(s).getByLabel("Subject").fill("Plans");
    await compose(s)
      .getByRole("textbox", { name: "Message" })
      .fill("**Bold** and a [link](https://example.org)");

    const file = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") };
    await compose(s)
      .locator('input[type="file"]')
      .setInputFiles([file, { ...file, name: "extra.txt" }]);
    await compose(s).getByRole("button", { name: "Remove extra.txt" }).click();
    await compose(s).getByText("extra.txt").waitFor({ state: "detached" });
    // Over 25 MB: refused in the browser, never uploaded. Built in the page, because sending
    // 25 MB through the DevTools protocol takes about a second.
    await compose(s)
      .locator('input[type="file"]')
      .evaluate((input: HTMLInputElement) => {
        const files = new DataTransfer();
        files.items.add(new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.bin"));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await compose(s).getByText("Larger than 25 MB; not attached.").waitFor();
    await compose(s).getByRole("button", { name: "Remove big.bin" }).click();

    app.send.sendDelay = 300;
    await compose(s).getByRole("button", { name: "Send", exact: true }).dblclick();
    await s.page.getByText("Message sent", { exact: true }).first().waitFor();
    expect(app.send.sends).toHaveLength(1);
    const [sent] = app.send.sends;
    expect(sent).toMatchObject({
      fromAddressId: 1,
      to: ["friend@example.org"],
      subject: "Plans",
      text: "**Bold** and a [link](https://example.org)",
      uploadIds: ["upload-1"],
      sourceId: null,
    });
    expect(String(sent?.html)).toContain(
      '<strong>Bold</strong> and a <a href="https://example.org"',
    );
    expect([...app.send.uploads.keys()]).toEqual(["upload-1"]);
    await compose(s).waitFor({ state: "detached" });

    await s.page.getByRole("link", { name: "Sent" }).click();
    await s.page
      .locator('[data-message-row="sent-1"]')
      .getByText("To: friend@example.org")
      .waitFor();
  });

  test("replies, replies all and forwards with the source in the request", async () => {
    const s = await open();
    await s.page.locator('[data-message-row="note1"]').click();
    await s.page.getByRole("button", { name: "Reply", exact: true }).click();
    await compose(s).getByText("friend@example.org", { exact: true }).waitFor();
    expect(await compose(s).getByLabel("Subject").inputValue()).toBe("Re: Note 1");
    const body = await compose(s).getByRole("textbox", { name: "Message" }).inputValue();
    expect(body).toMatch(/Friend wrote:\n\n> Plain note 1\./);
    await s.page.keyboard.press("Control+Enter");
    await s.page.getByText("Message sent", { exact: true }).first().waitFor();
    expect(app.send.sends[0]).toMatchObject({
      sourceId: "note1",
      sourceKind: "reply",
      subject: "Re: Note 1",
    });

    await s.page.locator('[data-message-row="note1"]').click();
    await s.page.locator("body").press("f");
    await compose(s).waitFor();
    expect(await compose(s).getByLabel("Subject").inputValue()).toBe("Fwd: Note 1");
    await s.page.locator("body").press("Escape");
    await s.page.goBack();
    await s.page.locator("body").press("a");
    await compose(s).getByText("friend@example.org", { exact: true }).waitFor();
    expect(s.page.url()).toContain("kind=replyAll");
  });

  test("autosaves the draft after the debounce and lists it in Drafts", async () => {
    const s = await open();
    // A fake clock, so the 2-second debounce does not cost the suite 2 seconds.
    await s.page.clock.install();
    await s.page.reload();
    await s.page.getByRole("button", { name: "Compose" }).click();
    await compose(s).getByLabel("Subject").fill("Draft subject");
    await s.page.clock.runFor(1500);
    expect(app.send.draftSaves).toEqual([]);
    await s.page.clock.runFor(600);
    await compose(s).getByText("Draft saved").waitFor();
    const saved = app.send.draftSaves.at(-1);
    expect(saved).toMatchObject({ subject: "Draft subject", to: [] });
    expect(String(saved?.idempotencyKey)).toMatch(/^[\w-]{36}$/);
    await s.page.getByRole("link", { name: "Drafts" }).click();
    await s.page.getByText("Draft subject").click();
    expect(await compose(s).getByLabel("Subject").inputValue()).toBe("Draft subject");
  });

  test("retries a failed send under the same key and a rejected one under a new key", async () => {
    const s = await open();
    app.send.answers = ["fail", "rejected"];
    await s.page.keyboard.press("c");
    await addRecipient(s, "To", "friend@example.org");
    await compose(s).getByLabel("Subject").fill("Typo");
    await compose(s).getByRole("button", { name: "Send", exact: true }).click();
    await compose(s).getByText("The message was not sent").waitFor();
    await compose(s).getByText("The mail service could not be reached").waitFor();
    await compose(s).getByRole("button", { name: "Send again" }).click();
    // A rejection: no Retry; the owner corrects the message and sends it as a new one.
    await compose(s).getByText("The mail service refused this message").waitFor();
    expect(await compose(s).getByRole("button", { name: "Send again" }).count()).toBe(0);
    const firstKey = app.send.sends[0]?.idempotencyKey;
    expect(app.send.sends[1]?.idempotencyKey).toBe(firstKey);
    // The draft moves to the new key at once, so autosave keeps working.
    const moved = () => app.send.draftSaves.find((d) => d.idempotencyKey !== firstKey);
    for (let i = 0; i < 100 && !moved(); i++) await Bun.sleep(20);
    const newKey = moved()?.idempotencyKey;
    expect(newKey).toBeString();

    await compose(s).getByLabel("Subject").fill("Fixed");
    await compose(s).getByRole("button", { name: "Send", exact: true }).click();
    await s.page.getByText("Message sent", { exact: true }).first().waitFor();
    expect(app.send.sends).toHaveLength(3);
    expect(app.send.sends[2]).toMatchObject({ subject: "Fixed", idempotencyKey: newKey });
  });

  test("warns near the quota, blocks when it is used up or sending is not set up", async () => {
    app.send.quota.daily.used = 85;
    const s = await open("/?compose=draft-quota-1");
    await compose(s)
      .getByText(/Today 85 \/ 100 · This month 340 \/ 3,000 · close to the limit/)
      .waitFor();

    app.send.quota.daily.used = 100;
    await s.page.reload();
    await compose(s)
      .getByText(/Today's sending quota is used up/)
      .first()
      .waitFor();
    await addRecipient(s, "To", "friend@example.org");
    const send = compose(s).getByRole("button", { name: "Send", exact: true });
    expect(await send.getAttribute("aria-disabled")).toBe("true");

    app.send.quota.daily.used = 12;
    app.send.setup.configured = false;
    await s.page.reload();
    await compose(s).getByText("Sending is not set up").first().waitFor();
    await addRecipient(s, "To", "friend@example.org");
    expect(await send.getAttribute("aria-disabled")).toBe("true");
  });

  test("previews the Markdown in the sandboxed mail frame", async () => {
    const s = await open("/?compose=draft-preview-1");
    await compose(s)
      .getByRole("textbox", { name: "Message" })
      .fill(
        "# Hi\n\n<script>parent.postMessage('x','*')</script>\n\n[js](javascript:alert(1)) [site](https://example.org)",
      );
    await compose(s).getByRole("radio", { name: "Preview" }).click();
    const frame = compose(s).locator("iframe");
    expect(await frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
    expect(srcdoc).toStartWith(
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy"',
    );
    expect(srcdoc).toContain("<h1");
    expect(srcdoc).toContain("&lt;script&gt;");
    expect(srcdoc).not.toMatch(/<script|javascript:/);
    // The reader's sanitizer ran as well: links open a new tab without opener or referrer.
    expect(srcdoc).toMatch(
      /href="https:\/\/example.org"[^>]* target="_blank" rel="noopener noreferrer"/,
    );
    expect(await s.page.frameLocator("[data-compose] iframe").locator("h1").textContent()).toBe(
      "Hi",
    );
    expect(s.remote).toEqual([]);
  });
});
