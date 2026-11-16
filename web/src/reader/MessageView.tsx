import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { PaperClipIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageDetail } from "../mailbox/api";
import { formatFullDate, formatSize } from "../mailbox/format";
import { downloadPart } from "./download";
import { MailFrame } from "./MailFrame";
import { PlainText } from "./PlainText";
import { fetchRaw, PROGRESS_FROM, parseMail } from "./parseMail";
import { sanitizeMailHtml } from "./sanitize";
import { fetchSentCopy } from "./sentCopy";
import type { MailAddress, MailPart, ParsedMail } from "./types";

type Load =
  | { state: "loading"; progress: number | null }
  | { state: "ready"; mail: ParsedMail & { bcc?: MailAddress[] }; raw: ArrayBuffer | null }
  | { state: "failed"; raw: ArrayBuffer | null };

const addressList = (list: MailAddress[]) =>
  list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** Downloads and parses one message in the browser (docs/M4-mailbox.md, "Reading mail", 1). */
function useParsedMail(message: MessageDetail): Load {
  const [load, setLoad] = useState<Load>({ state: "loading", progress: null });
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading", progress: null });
    const big = message.size > PROGRESS_FROM;
    (async () => {
      let raw: ArrayBuffer | null = null;
      try {
        if (message.direction === "out") {
          const mail = await fetchSentCopy(message.id);
          if (live) setLoad({ state: "ready", mail, raw: null });
          return;
        }
        raw = await fetchRaw(
          message.id,
          big ? (p) => live && setLoad({ state: "loading", progress: p }) : undefined,
        );
        // parseMail transfers its buffer to the worker; keep a copy for "Download original".
        const mail = await parseMail(raw.slice(0));
        if (live) setLoad({ state: "ready", mail, raw });
      } catch {
        if (live) setLoad({ state: "failed", raw });
      }
    })();
    return () => {
      live = false;
    };
  }, [message.id, message.size, message.direction]);
  return load;
}

function Header({
  message,
  mail,
}: {
  message: MessageDetail;
  mail: (ParsedMail & { bcc?: MailAddress[] }) | null;
}) {
  const { t, i18n } = useTranslation();
  const to = mail?.to.length ? addressList(mail.to) : (message.to ?? message.envelopeTo);
  const cc = mail?.cc.length ? addressList(mail.cc) : message.cc;
  const rows: [string, string][] = [
    [t("mail.to"), to],
    ...(cc ? ([[t("mail.cc"), cc]] as [string, string][]) : []),
    ...(mail?.bcc?.length ? ([[t("mail.bcc"), addressList(mail.bcc)]] as [string, string][]) : []),
    [t("mail.date"), formatFullDate(message.receivedAt, i18n.language)],
  ];
  return (
    <VStack gap={1}>
      {message.tag && (
        <HStack>
          <Token size="sm" label={`+${message.tag}`} description={t("mail.tag")} />
        </HStack>
      )}
      {rows.map(([label, value]) => (
        <HStack key={label} gap={2}>
          <Text type="supporting" color="secondary" textWrap="nowrap">
            {label}
          </Text>
          <Text type="supporting">{value}</Text>
        </HStack>
      ))}
    </VStack>
  );
}

function Attachments({ parts }: { parts: MailPart[] }) {
  const { t, i18n } = useTranslation();
  if (parts.length === 0) return null;
  return (
    <List
      header={
        <Text type="supporting" color="secondary">
          {t("mail.attachments")}
        </Text>
      }
      hasDividers
    >
      {parts.map((part, i) => (
        <ListItem
          // Parts have no stable id; their order in the message is fixed.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          key={i}
          itemKey={i}
          startContent={<Icon icon={PaperClipIcon} size="sm" color="secondary" />}
          label={part.filename ?? t("mail.unnamedAttachment")}
          description={formatSize(part.size ?? part.content.byteLength, i18n.language)}
          endContent={
            <Button
              label={t("mail.download")}
              variant="ghost"
              size="sm"
              onClick={() => void downloadPart(part, t("mail.unnamedAttachment")).catch(() => {})}
            />
          }
        />
      ))}
    </List>
  );
}

/** One expanded message of a thread: headers, body and attachments. */
export function MessageView({
  message,
  remoteImages,
  darkReading,
  onContent,
}: {
  message: MessageDetail;
  remoteImages: boolean;
  darkReading: boolean;
  /** Tells the reader what the toolbar can offer for this message. */
  onContent: (id: string, content: { remote: boolean; html: boolean }) => void;
}) {
  const { t } = useTranslation();
  const load = useParsedMail(message);
  const mail = load.state === "ready" ? load.mail : null;
  const clean = useMemo(
    () =>
      mail?.html
        ? sanitizeMailHtml(mail.html, {
            parts: mail.parts,
            remoteImages,
            tooLargeLabel: t("mail.imageTooLarge"),
          })
        : null,
    [mail, remoteImages, t],
  );
  const hasRemote = clean?.hasRemoteContent ?? false;
  const hasHtml = clean !== null;
  useEffect(
    () => onContent(message.id, { remote: hasRemote, html: hasHtml }),
    [message.id, hasRemote, hasHtml, onContent],
  );

  const files = mail
    ? mail.parts.filter((p) => !(p.contentId && clean?.usedContentIds.has(p.contentId)))
    : [];
  const raw = load.state === "loading" ? null : load.raw;

  return (
    <VStack gap={4} hAlign="stretch">
      <Header message={message} mail={mail} />
      {load.state === "loading" &&
        (load.progress === null ? (
          <Skeleton height="var(--size-control-lg)" />
        ) : (
          <ProgressBar label={t("mail.downloading")} value={load.progress * 100} hasValueLabel />
        ))}
      {load.state === "failed" && (
        <Banner
          status="error"
          title={t("mail.readFailed")}
          description={t("mail.readFailedDescription")}
          endContent={
            raw && (
              <Button
                label={t("mail.downloadOriginal")}
                variant="secondary"
                size="sm"
                onClick={() =>
                  void downloadPart(
                    {
                      filename: "message.eml",
                      mimeType: "message/rfc822",
                      disposition: "attachment",
                      contentId: null,
                      content: raw,
                    },
                    "message.eml",
                  )
                }
              />
            )
          }
        />
      )}
      {mail && clean && (
        <MailFrame
          html={clean.html}
          remoteImages={remoteImages}
          darkReading={darkReading}
          title={message.subject ?? t("mail.noSubject")}
        />
      )}
      {mail && !clean && mail.text && <PlainText text={mail.text} />}
      {mail && !clean && !mail.text && <Text color="secondary">{t("mail.noContent")}</Text>}
      <HStack>
        <StackItem size="fill">
          <Attachments parts={files} />
        </StackItem>
      </HStack>
    </VStack>
  );
}
