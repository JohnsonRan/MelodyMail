import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import { errorMessage } from "../errors";
import { useMailbox } from "../mailbox/MailboxContext";
import { MailFrame } from "../reader/MailFrame";
import { sanitizeMailHtml } from "../reader/sanitize";
import { AttachmentField } from "./AttachmentField";
import type { SourceKind } from "./api";
import { ComposeActions } from "./ComposeActions";
import { emailHtml } from "./markdown";
import { QuotaLine, quotaLevel } from "./QuotaLine";
import { RecipientField } from "./RecipientField";
import { useCompose } from "./useCompose";

type Props = {
  draftId: string;
  source: { id: string; kind: SourceKind } | null;
  onClose: () => void;
  /** Beside the list the panel draws its own heading; as a page the frame draws the title. */
  isPanel: boolean;
};

/** Compose, reply, reply all and forward (docs/M5-sending.md, "Screens"). */
export default function ComposeView({ draftId, source, onClose, isPanel }: Props) {
  const { t } = useTranslation("compose");
  const { t: tc } = useTranslation();
  const toast = useToast();
  const { addresses, refreshCounts } = useMailbox();
  const own = useMemo(() => addresses.map((a) => a.address), [addresses]);
  const c = useCompose({
    draftId,
    source,
    own,
    onSent: () => {
      toast({ body: t("sentToast") });
      void refreshCounts();
      onClose();
    },
  });
  const [mode, setMode] = useState("write");
  const [showCopies, setShowCopies] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { fields, setup } = c;

  const preview = useMemo(
    () =>
      mode === "preview"
        ? sanitizeMailHtml(emailHtml(fields.text), {
            parts: [],
            remoteImages: false,
            tooLargeLabel: "",
          }).html
        : "",
    [mode, fields.text],
  );

  const level = quotaLevel(c.quota);
  const uploading = c.entries.some((e) => !e.upload && !e.error);
  const blocked = !setup?.configured
    ? t("blocked.notConfigured")
    : fields.addressId === null
      ? t("blocked.noFrom")
      : fields.to.length + fields.cc.length + fields.bcc.length === 0
        ? t("blocked.noRecipients")
        : uploading
          ? t("blocked.uploading")
          : level === "dailyUsed" || level === "monthlyUsed"
            ? tc(`quota.${level}`)
            : null;

  // Ctrl+Enter (or Cmd+Enter) sends from anywhere in compose, text fields included.
  const sendRef = useRef(() => {});
  sendRef.current = () => {
    if (blocked === null && !c.sending) void c.send();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        sendRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Closing keeps the draft: a pending save runs when compose unmounts.
  const heading = isPanel && (
    <HStack hAlign="between" vAlign="center" gap={2}>
      <Heading level={2}>{t(source ? `title.${source.kind}` : "title.new")}</Heading>
      <IconButton
        label={t("close")}
        tooltip={t("close")}
        icon={<Icon icon={XMarkIcon} />}
        variant="ghost"
        onClick={onClose}
      />
    </HStack>
  );

  if (c.status !== "ready" || !setup) {
    return (
      <VStack gap={4} hAlign="stretch" padding={isPanel ? 4 : 0}>
        {heading}
        {c.status === "failed" ? (
          <Banner status="error" title={t("loadFailed")} />
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} height="var(--size-control-lg)" index={i} />)
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={4} hAlign="stretch" padding={isPanel ? 4 : 0} data-compose="">
      {heading}
      {!setup.configured && (
        <Banner status="info" title={t("notConfigured")} description={t("notConfiguredHelp")} />
      )}
      {setup.configured && setup.addresses.length === 0 && (
        <Banner
          status="info"
          title={t("noAddresses")}
          endContent={
            <Button
              label={tc("nav.domains")}
              variant="secondary"
              size="sm"
              href="/settings/domains"
            />
          }
        />
      )}
      <Selector
        label={t("from")}
        options={setup.addresses.map((a) => ({
          value: String(a.id),
          label: a.displayName ? `${a.displayName} <${a.address}>` : a.address,
        }))}
        value={fields.addressId === null ? undefined : String(fields.addressId)}
        onChange={(value) => c.change({ addressId: Number(value) })}
        isDisabled={setup.addresses.length === 0}
        width="100%"
      />
      <VStack gap={1} hAlign="stretch">
        <RecipientField
          label={t("to")}
          value={fields.to}
          onChange={(to) => c.change({ to })}
          hasAutoFocus={!source || source.kind === "forward"}
        />
        {!showCopies && fields.cc.length + fields.bcc.length === 0 && (
          <HStack hAlign="end">
            <Button
              label={t("addCopies")}
              variant="ghost"
              size="sm"
              onClick={() => setShowCopies(true)}
            />
          </HStack>
        )}
      </VStack>
      {(showCopies || fields.cc.length + fields.bcc.length > 0) && (
        <>
          <RecipientField label={t("cc")} value={fields.cc} onChange={(cc) => c.change({ cc })} />
          <RecipientField
            label={t("bcc")}
            value={fields.bcc}
            onChange={(bcc) => c.change({ bcc })}
          />
        </>
      )}
      <TextInput
        label={t("subject")}
        value={fields.subject}
        onChange={(subject) => c.change({ subject })}
        width="100%"
      />
      <SegmentedControl label={t("bodyMode")} value={mode} onChange={setMode}>
        <SegmentedControlItem value="write" label={t("write")} />
        <SegmentedControlItem value="preview" label={t("preview")} />
      </SegmentedControl>
      {mode === "write" ? (
        <TextArea
          label={t("body")}
          description={t("bodyHelp")}
          value={fields.text}
          onChange={(text) => c.change({ text })}
          rows={10}
          hasAutoFocus={source !== null && source.kind !== "forward"}
          width="100%"
        />
      ) : (
        <MailFrame html={preview} remoteImages={false} darkReading={false} title={t("preview")} />
      )}
      <AttachmentField
        entries={c.entries}
        enabled={setup.attachments}
        onAdd={(files) => c.addFiles(files.map((f) => ({ blob: f, name: f.name })))}
        onRemove={c.removeEntry}
      />
      {c.sendError !== null && (
        <Banner
          status="error"
          title={t("sendFailed")}
          description={errorMessage(tc, c.sendError)}
          endContent={
            // A rejected message is corrected and sent anew, not retried as it is.
            !(c.sendError instanceof ApiError && c.sendError.code === "send_rejected") && (
              <Button
                label={t("retry")}
                variant="secondary"
                size="sm"
                isLoading={c.sending}
                onClick={() => void c.send()}
              />
            )
          }
        />
      )}
      {c.quota && <QuotaLine quota={c.quota} />}
      <ComposeActions
        onSend={() => sendRef.current()}
        sending={c.sending}
        blocked={blocked}
        onSave={() => void c.saveNow(true)}
        save={c.save}
        onDiscard={() => setConfirmDiscard(true)}
      />
      <AlertDialog
        isOpen={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t("discardTitle")}
        description={t("discardDescription")}
        actionLabel={t("discard")}
        cancelLabel={tc("common.cancel")}
        onAction={async () => {
          await c.discard();
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </VStack>
  );
}
