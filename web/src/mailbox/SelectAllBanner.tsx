import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useTranslation } from "react-i18next";
import type { FolderCount } from "./api";

/**
 * "Select all matching" (docs/M8-mailbox-ux.md, section 2), as Gmail offers it: once every
 * loaded row is selected and more exist, the offer to select all N in the folder; in whole-folder
 * mode, what is selected and Clear selection; while a whole-folder change runs, its progress and
 * Stop.
 */
export function SelectAllBanner({
  folderName,
  loaded,
  offer,
  whole,
  progress,
  onSelectAll,
  onClear,
  onStop,
}: {
  folderName: string;
  loaded: number;
  offer: FolderCount | null;
  whole: FolderCount | null;
  progress: { done: number; total: number } | null;
  onSelectAll: () => void;
  onClear: () => void;
  onStop: () => void;
}) {
  const { t, i18n } = useTranslation();
  const n = (value: number) => value.toLocaleString(i18n.language);
  if (progress && whole) {
    return (
      <Banner
        status="info"
        title={t("mail.wholeProgress", { done: n(progress.done), total: n(progress.total) })}
        endContent={
          <Button label={t("mail.stop")} variant="secondary" size="sm" onClick={onStop} />
        }
      />
    );
  }
  if (whole) {
    return (
      <Banner
        status="info"
        title={t("mail.wholeSelected", { total: n(whole.total), folder: folderName })}
        endContent={
          <Button
            label={t("mail.clearSelection")}
            variant="secondary"
            size="sm"
            onClick={onClear}
          />
        }
      />
    );
  }
  if (!offer) return null;
  return (
    <Banner
      status="info"
      title={t("mail.loadedSelected", { count: n(loaded) })}
      endContent={
        <Button
          label={t("mail.selectAllIn", { total: n(offer.total), folder: folderName })}
          variant="secondary"
          size="sm"
          onClick={onSelectAll}
        />
      }
    />
  );
}
