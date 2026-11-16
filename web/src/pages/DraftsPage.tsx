import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { LayoutPanel } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { DocumentTextIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageFrame } from "../components/PageFrame";
import { type DraftSummary, listDrafts } from "../compose/api";
import { ComposeSlot, useComposeRoute } from "../compose/route";
import { formatListDate } from "../mailbox/format";
import { ListSkeleton } from "../mailbox/ListBody";

const SIDE_BY_SIDE = "(min-width: 1280px)";

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; drafts: DraftSummary[] };

/** The Drafts folder: unsent drafts, newest first; opening one continues it in compose. */
export function DraftsPage() {
  const { t, i18n } = useTranslation();
  const sideBySide = useMediaQuery(SIDE_BY_SIDE);
  const compose = useComposeRoute();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const reload = useCallback(async () => {
    try {
      setLoad({ state: "ready", drafts: (await listDrafts()).drafts });
    } catch {
      setLoad({ state: "failed" });
    }
  }, []);
  // Compose saves or deletes the draft; the list follows when it closes.
  useEffect(() => {
    if (!compose.composeId) void reload();
  }, [compose.composeId, reload]);

  const composer = compose.composeId && (
    <ComposeSlot
      draftId={compose.composeId}
      source={compose.source}
      onClose={compose.close}
      isPanel={sideBySide}
    />
  );
  if (!sideBySide && composer) {
    return (
      <PageFrame
        title={t(`mail.composeTitle.${compose.source?.kind ?? "new"}`)}
        actions={
          <Button label={t("mail.closeCompose")} variant="secondary" onClick={compose.close} />
        }
      >
        {composer}
      </PageFrame>
    );
  }

  return (
    <PageFrame
      title={t("folder.drafts")}
      actions={
        <Button
          label={t("mail.compose")}
          icon={<Icon icon={PencilSquareIcon} size="sm" />}
          variant="primary"
          onClick={() => compose.open()}
        />
      }
      end={
        sideBySide && (
          <LayoutPanel width="58%" hasDivider padding={0} label={t("mail.composePanel")}>
            {composer || (
              <Center height="100%">
                <EmptyState
                  icon={<Icon icon={DocumentTextIcon} size="lg" color="secondary" />}
                  title={t("mail.noDraftOpen")}
                />
              </Center>
            )}
          </LayoutPanel>
        )
      }
    >
      {load.state === "loading" && <ListSkeleton />}
      {load.state === "failed" && (
        <Banner
          status="error"
          title={t("mail.draftsFailed")}
          endContent={
            <Button
              label={t("mail.retry")}
              variant="secondary"
              size="sm"
              onClick={() => void reload()}
            />
          }
        />
      )}
      {load.state === "ready" && load.drafts.length === 0 && (
        <Center height="100%">
          <EmptyState
            icon={<Icon icon={DocumentTextIcon} size="lg" color="secondary" />}
            title={t("mail.empty.drafts")}
          />
        </Center>
      )}
      {load.state === "ready" && load.drafts.length > 0 && (
        <List hasDividers>
          {load.drafts.map((d) => (
            <ListItem
              key={d.id}
              itemKey={d.id}
              data-draft-row={d.id}
              isSelected={d.id === compose.composeId}
              onClick={() => compose.open(undefined, d.id)}
              label={d.subject || t("mail.noSubject")}
              description={[
                d.to.length > 0
                  ? t("mail.toLine", { to: d.to.join(", ") })
                  : t("mail.noRecipients"),
                d.snippet,
              ]
                .filter(Boolean)
                .join(" · ")}
              endContent={
                <Text type="supporting" textWrap="nowrap" hasTabularNumbers>
                  {formatListDate(d.updatedAt, i18n.language)}
                </Text>
              }
            />
          ))}
        </List>
      )}
    </PageFrame>
  );
}
