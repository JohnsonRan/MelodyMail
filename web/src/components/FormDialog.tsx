import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** A small form in a modal dialog: fields, then Cancel and the one primary action. */
export function FormDialog({
  isOpen,
  onClose,
  title,
  submitLabel,
  isSubmitting,
  onSubmit,
  width = 480,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  submitLabel: string;
  isSubmitting: boolean;
  onSubmit: () => void;
  /** The rule editor needs room for a condition row; the other forms keep 480. */
  width?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      purpose="form"
      width={width}
    >
      <Layout
        header={<DialogHeader title={title} onOpenChange={(open) => !open && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4} hAlign="stretch">
              {children}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label={t("common.cancel")} variant="secondary" onClick={onClose} />
              <Button
                label={submitLabel}
                variant="primary"
                isLoading={isSubmitting}
                onClick={onSubmit}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
