import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { errorMessage } from "../errors";
import { formatListDate } from "../mailbox/format";
import { ACTIONS, type RuleDraft, type RuleTest, ruleBody } from "./types";

type Sample = { id: string; from: string; subject: string | null; receivedAt: number };

// The 20 newest messages of the Inbox: an indexed folder query the mailbox already runs.
const SAMPLE_PATH = "/messages?folder=inbox&limit=20";

/** Tests the rule being edited against a stored message; the Worker changes nothing. */
export function RuleTestPanel({ draft }: { draft: RuleDraft }) {
  const { t, i18n } = useTranslation("rules");
  const { t: tCommon } = useTranslation();
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [messageId, setMessageId] = useState("");
  const [result, setResult] = useState<RuleTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api<{ messages: Sample[] }>("GET", SAMPLE_PATH)
      .then((page) => {
        setSamples(page.messages);
        setMessageId(page.messages[0]?.id ?? "");
      })
      .catch(() => setSamples([]));
  }, []);

  const run = async () => {
    setTesting(true);
    setError(null);
    try {
      setResult(await api<RuleTest>("POST", "/rules/test", { messageId, rule: ruleBody(draft) }));
    } catch (err) {
      setResult(null);
      setError(errorMessage(tCommon, err));
    } finally {
      setTesting(false);
    }
  };

  const label = (s: Sample) =>
    `${s.from} · ${s.subject ?? t("test.noSubject")} · ${formatListDate(s.receivedAt, i18n.language)}`;
  const actions = result
    ? [
        ...(result.targets.length > 0
          ? [t("action.forwardTo", { targets: result.targets.join(", ") })]
          : []),
        ...ACTIONS.filter((a) => result[a]).map((a) => t(`action.${a}`)),
      ]
    : [];

  return (
    <VStack gap={2} hAlign="stretch">
      <Heading level={3}>{t("test.title")}</Heading>
      <Text type="supporting">{t("test.description")}</Text>
      {samples !== null && samples.length === 0 ? (
        <Text color="secondary">{t("test.noMessages")}</Text>
      ) : (
        <HStack gap={2} vAlign="end" wrap="wrap">
          <Selector
            label={t("test.message")}
            options={(samples ?? []).map((s) => ({ value: s.id, label: label(s) }))}
            value={messageId}
            onChange={setMessageId}
            isDisabled={samples === null}
          />
          <Button
            label={t("test.run")}
            variant="secondary"
            isLoading={testing}
            isDisabled={!messageId}
            onClick={() => void run()}
          />
        </HStack>
      )}
      {error && <Banner status="error" title={error} />}
      {result && (
        <Banner
          status={result.matched ? "success" : "info"}
          title={result.matched ? t("test.matched") : t("test.notMatched")}
          description={[
            ...result.conditions.map((c, i) =>
              t(c.matched ? "test.conditionMatched" : "test.conditionNotMatched", { n: i + 1 }),
            ),
            ...(actions.length > 0 ? [t("test.actions", { actions: actions.join(", ") })] : []),
          ].join(" ")}
        />
      )}
    </VStack>
  );
}
