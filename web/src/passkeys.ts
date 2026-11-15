import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { api } from "./api";

type Options<T> = { options: T };

/** Registers one more Passkey for the signed-in owner. */
export async function addPasskey(label: string): Promise<void> {
  const { options } = await api<Options<PublicKeyCredentialCreationOptionsJSON>>(
    "POST",
    "/auth/passkeys/options",
    {},
  );
  const credential = await startRegistration({ optionsJSON: options });
  await api("POST", "/auth/passkeys/verify", { credential, label });
}

export async function signInWithPasskey(): Promise<void> {
  const { options } = await api<Options<PublicKeyCredentialRequestOptionsJSON>>(
    "POST",
    "/auth/login/options",
    {},
  );
  const credential = await startAuthentication({ optionsJSON: options });
  await api("POST", "/auth/login/verify", { credential });
}

/** Groups a code into blocks of four so it wraps only between blocks. */
export function groupInFours(value: string): string {
  return (value.match(/.{1,4}/g) ?? []).join(" ");
}
