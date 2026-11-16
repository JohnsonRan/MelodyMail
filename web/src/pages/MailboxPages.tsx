import { useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { Folder } from "../mailbox/api";
import { useMailbox } from "../mailbox/MailboxContext";
import { MailboxPage } from "./MailboxPage";

// One route component per mailbox view; each is a lazy chunk entry (router.tsx).

function FolderPage({ folder }: { folder: Folder }) {
  const { t } = useTranslation();
  return <MailboxPage query={{ folder }} title={t(`folder.${folder}`)} />;
}

export const InboxPage = () => <FolderPage folder="inbox" />;
export const StarredPage = () => <FolderPage folder="starred" />;
export const SentPage = () => <FolderPage folder="sent" />;
export { DraftsPage } from "./DraftsPage";
export const ArchivePage = () => <FolderPage folder="archive" />;
export const TrashPage = () => <FolderPage folder="trash" />;

export function AddressPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const { t } = useTranslation();
  const { addresses } = useMailbox();
  const address = addresses.find((a) => String(a.id) === id);
  return (
    <MailboxPage
      query={{ folder: "inbox", address: Number(id) }}
      title={address?.address ?? t("nav.addresses")}
    />
  );
}

export function SearchPage() {
  const { t } = useTranslation();
  const { q } = useSearch({ strict: false }) as { q?: string };
  return (
    <MailboxPage query={{ search: q ?? "" }} title={t("mail.searchTitle", { query: q ?? "" })} />
  );
}
