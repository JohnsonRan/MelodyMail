import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { ApiError, api } from "./api";

type Options<T> = { options: T };

async function assertPasskey(optionsPath: string, verifyPath: string): Promise<void> {
  const { options } = await api<Options<PublicKeyCredentialRequestOptionsJSON>>(
    "POST",
    optionsPath,
    {},
  );
  const credential = await startAuthentication({ optionsJSON: options });
  await api("POST", verifyPath, { credential });
}

export function signInWithPasskey(): Promise<void> {
  return assertPasskey("/auth/login/options", "/auth/login/verify");
}

/**
 * Runs a sensitive action. When the server answers reauth_required, the owner confirms with a
 * Passkey and the action runs once more.
 */
export async function withReauth<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "reauth_required")) throw err;
    await assertPasskey("/auth/reauth/options", "/auth/reauth/verify");
    return action();
  }
}

/** Registers one more Passkey for the signed-in owner. */
export async function addPasskey(label: string): Promise<void> {
  const { options } = await withReauth(() =>
    api<Options<PublicKeyCredentialCreationOptionsJSON>>("POST", "/auth/passkeys/options", {}),
  );
  const credential = await startRegistration({ optionsJSON: options });
  await withReauth(() => api("POST", "/auth/passkeys/verify", { credential, label }));
}

/** Groups a code into blocks of four so it wraps only between blocks. */
export function groupInFours(value: string): string {
  return (value.match(/.{1,4}/g) ?? []).join(" ");
}
