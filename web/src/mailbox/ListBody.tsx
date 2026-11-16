import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { InboxIcon, MagnifyingGlassIcon, SignalSlashIcon } from "@heroicons/react/24/outline";
import type { ComponentProps, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNetwork } from "../network";
import type { ListQuery } from "./api";
import { MessageList } from "./MessageList";
import type { ListState } from "./useMessageList";

/** The loading state of a list, and of the reader while its chunk loads. */
export function ListSkeleton() {
  return (
    <VStack gap={2} hAlign="stretch">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} height="calc(var(--size-control-lg) * 2)" index={i} />
      ))}
    </VStack>
  );
}

/** The list area: skeleton, error, empty state or rows, and the sentinel for the next page. */
export function ListBody({
  query,
  list,
  sentinel,
  onRetry,
  rows,
}: {
  query: ListQuery;
  list: ListState;
  sentinel: RefObject<HTMLElement | null>;
  onRetry: () => void;
  rows: Omit<ComponentProps<typeof MessageList>, "messages">;
}) {
  const { t } = useTranslation();
  const search = "search" in query;
  const { offline } = useNetwork();
  return (
    <>
      {list.status === "loading" && <ListSkeleton />}
      {list.status === "error" && offline && (
        <Center height="100%">
          <EmptyState
            icon={<Icon icon={SignalSlashIcon} size="lg" color="secondary" />}
            title={t("mail.offlineList")}
          />
        </Center>
      )}
      {list.status === "error" && !offline && (
        <Banner
          status="error"
          title={t("mail.listFailed")}
          endContent={
            <Button label={t("mail.retry")} variant="secondary" size="sm" onClick={onRetry} />
          }
        />
      )}
      {list.status === "ready" && list.items.length === 0 && (
        <Center height="100%">
          <EmptyState
            icon={
              <Icon icon={search ? MagnifyingGlassIcon : InboxIcon} size="lg" color="secondary" />
            }
            title={search ? t("mail.noResults") : t(`mail.empty.${query.folder}`)}
            description={search ? t("mail.noResultsDescription") : undefined}
          />
        </Center>
      )}
      {list.status === "ready" && list.items.length > 0 && (
        <MessageList messages={list.items} {...rows} />
      )}
      {list.next && <VStack ref={sentinel} height="var(--spacing-1)" />}
      {list.loadingMore && <Skeleton height="calc(var(--size-control-lg) * 2)" />}
    </>
  );
}
