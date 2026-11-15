import { log } from "../http";

// Records Cloudflare Email Routing needs on the root domain. Source: Cloudflare docs, "Domain
// configuration", Routing records
// (https://developers.cloudflare.com/email-service/configuration/domains/, read 2026-11-16).
// Cloudflare assigns the MX priorities, so only the hosts are checked.
export const EMAIL_ROUTING_MX = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
];
export const EMAIL_ROUTING_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";
const EMAIL_ROUTING_SPF = `v=spf1 ${EMAIL_ROUTING_SPF_INCLUDE} ~all`;
// Email Routing signs forwarded mail with its own key, published by Cloudflare as a TXT record
// "v=DKIM1; h=sha256; k=rsa; p=<public key>" at this selector (same page, Routing records). The
// key is Cloudflare's, so only the form is checked.
export const EMAIL_ROUTING_DKIM_SELECTOR = "cf2024-1._domainkey";
const EMAIL_ROUTING_DKIM = "v=DKIM1; h=sha256; k=rsa; p=…";
// A starting policy that only reports; the owner tightens it once mail flows.
const SUGGESTED_DMARC = "v=DMARC1; p=none;";

const DOH_TIMEOUT_MS = 5_000;
const TYPE = { MX: 15, TXT: 16 } as const;
const NOERROR = 0;
const NXDOMAIN = 3;

export type RecordId = "mx" | "spf" | "dkim" | "dmarc";
export type Status = "found" | "missing" | "different";

/** What the owner must publish. `value: null` means the value comes from the Resend dashboard. */
export function expectedRecords(domain: string) {
  return {
    receive: [
      { id: "mx", type: "MX", name: domain, values: EMAIL_ROUTING_MX },
      { id: "spf", type: "TXT", name: domain, values: [EMAIL_ROUTING_SPF] },
      {
        id: "dkim",
        type: "TXT",
        name: `${EMAIL_ROUTING_DKIM_SELECTOR}.${domain}`,
        values: [EMAIL_ROUTING_DKIM],
      },
      { id: "dmarc", type: "TXT", name: `_dmarc.${domain}`, values: [SUGGESTED_DMARC] },
    ],
    // Sending through Resend arrives in M5; until then these are placeholders.
    send: [
      { id: "resend-dkim", type: "TXT", name: null, values: null },
      { id: "resend-spf", type: "TXT", name: null, values: null },
      { id: "resend-return-path", type: "MX", name: null, values: null },
    ],
  };
}

export class DnsLookupError extends Error {}

type DohAnswer = { type: number; data: string };

/** One DoH JSON query. NXDOMAIN gives no answers; any other failure throws DnsLookupError. */
async function query(dohUrl: string, name: string, type: keyof typeof TYPE): Promise<string[]> {
  const url = `${dohUrl}?name=${encodeURIComponent(name)}&type=${type}`;
  let body: { Status?: unknown; Answer?: DohAnswer[] };
  try {
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) throw new DnsLookupError(`http ${res.status}`);
    body = await res.json();
  } catch (e) {
    // Operator detail goes to the log only; the owner sees dns_check_failed.
    log("warn", "dns_check_failed", { type, error: e instanceof Error ? e.message : String(e) });
    throw new DnsLookupError("lookup failed");
  }
  if (body.Status === NXDOMAIN) return [];
  if (body.Status !== NOERROR) {
    log("warn", "dns_check_failed", { type, status: body.Status });
    throw new DnsLookupError("lookup failed");
  }
  return (body.Answer ?? []).filter((a) => a.type === TYPE[type]).map((a) => a.data);
}

/** TXT data arrives as one or more quoted strings; a record is their concatenation. */
export function txtValue(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
  return parts.length ? parts.join("").replace(/\\(.)/g, "$1") : data;
}

const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

function mxStatus(found: string[]): Status {
  if (found.length === 0) return "missing";
  const hosts = new Set(found.map((d) => host(d.split(/\s+/).at(-1) ?? "")));
  const same =
    hosts.size === EMAIL_ROUTING_MX.length && EMAIL_ROUTING_MX.every((h) => hosts.has(h));
  return same ? "found" : "different";
}

function spfStatus(found: string[]): Status {
  if (found.length === 0) return "missing";
  // A domain must have exactly one SPF record; two make SPF fail.
  const ok =
    found.length === 1 && found[0]?.toLowerCase().split(/\s+/).includes(EMAIL_ROUTING_SPF_INCLUDE);
  return ok ? "found" : "different";
}

function dmarcStatus(txt: string[], found: string[]): Status {
  if (found.length === 1) return "found";
  return txt.length === 0 ? "missing" : "different";
}

/** One DKIM key record with a public key; an empty p= means the key was revoked. */
function dkimStatus(txt: string[]): Status {
  if (txt.length === 0) return "missing";
  const keys = txt.filter((t) => /^v=DKIM1(;|\s|$)/i.test(t));
  const ok =
    keys.length === 1 && txt.length === 1 && /(^|;)\s*p=[A-Za-z0-9+/=]+/.test(keys[0] ?? "");
  return ok ? "found" : "different";
}

/** Looks up the receiving records in parallel: four subrequests. */
export async function checkDns(dohUrl: string, domain: string) {
  const [mx, rootTxt, dkimTxt, dmarcTxt] = await Promise.all([
    query(dohUrl, domain, "MX"),
    query(dohUrl, domain, "TXT"),
    query(dohUrl, `${EMAIL_ROUTING_DKIM_SELECTOR}.${domain}`, "TXT"),
    query(dohUrl, `_dmarc.${domain}`, "TXT"),
  ]);
  const spf = rootTxt.map(txtValue).filter((t) => /^v=spf1(\s|$)/i.test(t));
  const dkim = dkimTxt.map(txtValue);
  const dmarcAll = dmarcTxt.map(txtValue);
  const dmarc = dmarcAll.filter((t) => /^v=DMARC1(;|\s|$)/i.test(t));
  return [
    { id: "mx" as RecordId, status: mxStatus(mx), found: mx },
    { id: "spf" as RecordId, status: spfStatus(spf), found: spf },
    { id: "dkim" as RecordId, status: dkimStatus(dkim), found: dkim },
    { id: "dmarc" as RecordId, status: dmarcStatus(dmarcAll, dmarc), found: dmarcAll },
  ];
}
