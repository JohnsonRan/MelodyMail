import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NARROW } from "../breakpoints";
import { SETTINGS_NAV } from "../components/MailShell";
import { PageFrame } from "../components/PageFrame";

/**
 * /settings on a phone: the settings sections as a list, as iOS Settings and the Gmail app open
 * their settings. Wider screens show the sections in the side navigation and open Domains.
 */
export function SettingsIndexPage() {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW);
  if (!narrow) return <Navigate to="/settings/domains" replace />;
  return (
    <PageFrame title={t("nav.settings")}>
      {SETTINGS_NAV.map(({ title, items }) => (
        <List
          key={title}
          header={
            <Text type="supporting" color="secondary">
              {t(title)}
            </Text>
          }
          edge="flush"
          density="spacious"
          hasDividers
        >
          {items.map(({ key, path, icon }) => (
            <ListItem
              key={key}
              label={t(`nav.${key}`)}
              href={path}
              startContent={<Icon icon={icon} />}
              endContent={<Icon icon={ChevronRightIcon} color="secondary" />}
            />
          ))}
        </List>
      ))}
    </PageFrame>
  );
}
