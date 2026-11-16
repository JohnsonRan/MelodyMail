/**
 * The app's mark, the same file as the favicon and the PWA icons (web/public/logo.svg). It
 * carries its own dark tile, so it reads on the light and the dark palette alike. Decorative:
 * the app name always stands next to it.
 */
export function AppLogo({ size }: { size: "md" | "lg" }) {
  const side = `var(--size-element-${size})`;
  return <img src="/logo.svg" alt="" style={{ width: side, height: side, display: "block" }} />;
}
