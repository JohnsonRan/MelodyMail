import type { TFunction } from "i18next";

export type SessionPlace = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  organization: string | null;
  geoSource: string | null;
};

/**
 * The lines that say where a session was opened: the IP address, then "city, region, country ·
 * provider", or the local-network label. Missing parts are left out.
 */
export function placeLines(t: TFunction, locale: string, place: SessionPlace): string[] {
  const lines: string[] = [];
  if (place.ip) lines.push(t("security.ipAddress", { ip: place.ip }));
  if (place.geoSource === "local") {
    lines.push(t("security.localNetwork"));
    return lines;
  }
  const country =
    place.country && /^[A-Z]{2}$/.test(place.country)
      ? (new Intl.DisplayNames([locale], { type: "region" }).of(place.country) ?? place.country)
      : place.country;
  const where = [place.city, place.region, country].filter(Boolean).join(", ");
  const line = [where, place.organization].filter(Boolean).join(" · ");
  if (line) lines.push(line);
  return lines;
}
