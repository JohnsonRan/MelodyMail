import { AppShell } from "@astryxdesign/core/AppShell";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import {
  ArchiveBoxIcon,
  ArrowUturnRightIcon,
  AtSymbolIcon,
  DocumentIcon,
  EnvelopeIcon,
  GlobeAltIcon,
  InboxIcon,
  PaperAirplaneIcon,
  ShieldCheckIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PreferenceSelectors } from "../preferences";

/** The signed-in frame: app bar, folder navigation and the page outlet. */
export function MailShell() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <AppShell
      contentPadding={6}
      style={{ height: "100dvh", minHeight: 0 }}
      topNav={
        <TopNav
          label={t("nav.main")}
          heading={
            <TopNavHeading
              heading={t("app.name")}
              logo={<NavIcon icon={<Icon icon={EnvelopeIcon} size="sm" />} />}
            />
          }
          endContent={<PreferenceSelectors />}
        />
      }
      sideNav={
        <SideNav>
          <SideNavSection title={t("nav.mail")} isHeaderHidden>
            <SideNavItem
              label={t("folder.inbox")}
              icon={InboxIcon}
              isSelected={pathname === "/"}
              href="/"
            />
            <SideNavItem label={t("folder.sent")} icon={PaperAirplaneIcon} isDisabled />
            <SideNavItem label={t("folder.drafts")} icon={DocumentIcon} isDisabled />
            <SideNavItem label={t("folder.archive")} icon={ArchiveBoxIcon} isDisabled />
            <SideNavItem label={t("folder.trash")} icon={TrashIcon} isDisabled />
          </SideNavSection>
          <SideNavSection title={t("nav.manage")}>
            <SideNavItem
              label={t("nav.domains")}
              icon={GlobeAltIcon}
              isSelected={pathname.startsWith("/settings/domains")}
              href="/settings/domains"
            />
            <SideNavItem
              label={t("nav.addresses")}
              icon={AtSymbolIcon}
              isSelected={pathname === "/settings/addresses"}
              href="/settings/addresses"
            />
            <SideNavItem
              label={t("nav.forwarding")}
              icon={ArrowUturnRightIcon}
              isSelected={pathname === "/settings/forwarding"}
              href="/settings/forwarding"
            />
            <SideNavItem
              label={t("nav.security")}
              icon={ShieldCheckIcon}
              isSelected={pathname === "/settings/security"}
              href="/settings/security"
            />
          </SideNavSection>
        </SideNav>
      }
    >
      <Outlet />
    </AppShell>
  );
}
