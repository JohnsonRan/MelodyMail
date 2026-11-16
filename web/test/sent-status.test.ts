import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { StubApp } from "./stub-app";
import { sentMessage } from "./stub-send";

// The sent-message status in the reader through the built app (docs/M5-sending.md, "Proof"):
// where Retry is offered, the unknown state past the retry window and "Send as a new message",
// against stub-send.ts. Runs in `bun run test:send` with compose.test.ts.

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

const compose = (s: Session) => s.page.locator("[data-compose]");

describe("sent status in the reader", () => {
  test("offers Retry in the reader only where it may still send", async () => {
    const seed = (
      id: string,
      status: string,
      error: string | null = null,
      age = 0,
      first: { age?: number; maybeAccepted?: number } = {},
    ) => {
      const body = {
        to: ["friend@example.org"],
        bcc: ["hidden@example.org"],
        subject: id,
        text: "Hi",
        idempotencyKey: id,
      };
      const stored = sentMessage(id, body, status);
      stored.item.error = error;
      stored.item.receivedAt = Date.now() - age;
      stored.item.firstAttemptAt = Date.now() - (first.age ?? age);
      stored.item.maybeAccepted = first.maybeAccepted ?? 0;
      const attachment = { uploadId: "up-1", filename: "notes.txt", contentType: "text/plain" };
      stored.raw = JSON.stringify({
        ...JSON.parse(stored.raw),
        attachments: [{ ...attachment, size: 5 }],
      });
      app.store.set(id, stored);
    };
    seed("sent-lost", "delivery_failed");
    // An earlier attempt's outcome was unknown, but the rejection that followed is final.
    seed("sent-rejected", "failed", "send_rejected", 25 * 3600_000, { maybeAccepted: 1 });
    seed("sent-fresh", "sending", null, 10_000);
    // Claimed again 2 minutes ago, but first attempted 25 h ago: the window counts from then.
    seed("sent-unknown", "sending", null, 2 * 60_000, { age: 25 * 3600_000 });
    seed("sent-failed-unknown", "failed", "send_failed", 25 * 3600_000, { maybeAccepted: 1 });
    seed("sent-failed", "failed", "send_failed", 60 * 60_000, { maybeAccepted: 1 });
    seed("sent-stalled", "sending", null, 5 * 60_000);
    session = await openSession(app.origin, "/sent?m=sent-lost");
    const s = session;
    const retry = s.page.getByRole("button", { name: "Send again" });
    // Reported by Resend: final.
    await s.page.locator('[data-message-row="sent-lost"]').getByText("Delivery failed").waitFor();
    await s.page.getByText("Resend reported that this message could not be delivered.").waitFor();
    await s.page.getByText("notes.txt").first().waitFor();
    expect(await retry.count()).toBe(0);
    // Rejected: final, and its attachments went back to the draft.
    await s.page.locator('[data-message-row="sent-rejected"]').click();
    await s.page.getByText("The mail service refused this message").waitFor();
    expect(await retry.count()).toBe(0);
    expect(await s.page.getByText("notes.txt").count()).toBe(0);
    // Sending for 10 s: still in progress, nothing to do.
    await s.page.locator('[data-message-row="sent-fresh"]').click();
    await s.page.getByRole("heading", { name: "sent-fresh" }).waitFor();
    expect(await retry.count()).toBe(0);
    // A network failure past the window: Resend may have sent it; no Retry.
    const asNew = s.page.getByRole("button", { name: "Send as a new message" });
    await s.page.locator('[data-message-row="sent-failed-unknown"]').click();
    await s.page.getByText("Status unknown, check Resend").waitFor();
    expect(await retry.count()).toBe(0);
    await asNew.waitFor();
    // Unfinished after 5 minutes: Retry under the same key. While another attempt holds the
    // row the status stays; then the retry goes out.
    app.send.answers = ["inProgress"];
    await s.page.locator('[data-message-row="sent-stalled"]').click();
    await s.page.getByText("This message started sending but did not finish.").waitFor();
    await retry.click();
    await s.page
      .getByText("This message is being sent. Wait a moment, then check Sent.")
      .first()
      .waitFor();
    expect(await s.page.getByText("This message started sending but did not finish.").count()).toBe(
      1,
    );
    await retry.click();
    await s.page.getByText("Message sent", { exact: true }).first().waitFor();
    expect(app.send.sends).toEqual([
      { idempotencyKey: "sent-stalled" },
      { idempotencyKey: "sent-stalled" },
    ]);
    // A failed send inside the window whose Retry the Worker refuses as past it: unknown.
    app.send.answers = ["unknown"];
    await s.page.locator('[data-message-row="sent-failed"]').click();
    await retry.click();
    await asNew.waitFor();
    expect(await retry.count()).toBe(0);

    // Unfinished, first attempted 25 h ago: sent as a new message under a new key.
    await s.page.locator('[data-message-row="sent-unknown"]').click();
    await s.page.getByText("Check its status in the Resend dashboard.").waitFor();
    expect(await retry.count()).toBe(0);
    await asNew.click();
    await compose(s).getByText("The earlier message may already have been delivered").waitFor();
    await compose(s).getByText("friend@example.org", { exact: true }).waitFor();
    expect(await compose(s).getByLabel("Subject").inputValue()).toBe("sent-unknown");
    expect(await compose(s).getByRole("textbox", { name: "Message" }).inputValue()).toBe("Hi");
    await compose(s).getByText("notes.txt", { exact: true }).waitFor();
    const send = compose(s).getByRole("button", { name: "Send", exact: true });
    await s.page.waitForFunction(
      (el) => el?.getAttribute("aria-disabled") !== "true",
      await send.elementHandle(),
    );
    await send.click();
    await compose(s).waitFor({ state: "detached" });
    expect(app.send.sends).toHaveLength(4);
    const again = app.send.sends.at(-1);
    expect(again).toMatchObject({
      to: ["friend@example.org"],
      bcc: ["hidden@example.org"],
      subject: "sent-unknown",
      text: "Hi",
      sourceId: null,
      sourceKind: null,
      uploadIds: ["upload-1"],
    });
    // A new key: the old one is "sent-unknown".
    expect(String(again?.idempotencyKey)).toMatch(/^[\w-]{36}$/);
  });
});
