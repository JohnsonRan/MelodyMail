import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { SELECTABLE } from "../selection";

// A plain-text body as React text: no HTML is involved. http(s) URLs become links that open a new
// tab without opener or referrer (docs/M4-mailbox.md, "Reading mail", 2).

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

function linkify(line: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING, "");
    const start = match.index;
    nodes.push(line.slice(last, start));
    nodes.push(
      <Link key={start} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </Link>,
    );
    last = start + url.length;
  }
  nodes.push(line.slice(last));
  return nodes;
}

export function PlainText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return (
    <VStack gap={0} hAlign="stretch" style={SELECTABLE}>
      {lines.map((line, i) => (
        // Lines have no identity of their own; the index is stable for a given text.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <Text key={i} display="block">
          {line.length > 0 ? linkify(line) : " "}
        </Text>
      ))}
    </VStack>
  );
}
