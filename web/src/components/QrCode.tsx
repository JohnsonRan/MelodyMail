import { encode } from "uqr";

/**
 * A QR code drawn as SVG. It stays black on white in every theme, because some authenticator
 * apps cannot read an inverted code.
 */
export function QrCode({
  value,
  label,
  size = 192,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { data, size: modules } = encode(value, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
    >
      <rect width={modules} height={modules} fill="var(--color-on-dark)" />
      <path d={path} fill="var(--color-on-light)" />
    </svg>
  );
}
