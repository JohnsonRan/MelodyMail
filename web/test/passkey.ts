import type { Page } from "playwright";

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

/** A platform authenticator holding one discoverable Passkey for localhost (Chromium CDP). */
export async function passkey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: b64(crypto.getRandomValues(new Uint8Array(16))),
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      userHandle: b64(new TextEncoder().encode("owner")),
      signCount: 0,
    },
  });
}
