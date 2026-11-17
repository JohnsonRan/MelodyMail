import { Button } from "@astryxdesign/core/Button";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageFrame } from "../components/PageFrame";
import type { ComposeKind } from "./api";

/**
 * Compose as a page (below the side-by-side width): Close and Send sit in the title row, which
 * stays at the top while the fields scroll, so both are in reach with a phone keyboard up.
 */
export function ComposePageFrame({
  kind,
  onClose,
  send,
  children,
}: {
  kind: ComposeKind | undefined;
  onClose: () => void;
  send: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <PageFrame
      title={t(`mail.composeTitle.${kind ?? "new"}`)}
      actions={
        <>
          <Button label={t("mail.closeCompose")} variant="secondary" onClick={onClose} />
          {send}
        </>
      }
    >
      {children}
    </PageFrame>
  );
}
