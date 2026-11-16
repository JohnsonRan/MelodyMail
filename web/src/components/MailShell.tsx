import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import {
  ArchiveBoxIcon,
  ArrowUturnRightIcon,
  AtSymbolIcon,
  EnvelopeIcon,
  GlobeAltIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Folder } from "../mailbox/api";
import { MailboxProvider, useMailbox } from "../mailbox/MailboxContext";
import { useNetwork } from "../network";
import { PreferenceSelectors } from "../preferences";
import { SystemBanners } from "./SystemBanners";

const FOLDER_NAV: { folder: Folder; path: string; icon: typeof InboxIcon }[] = [
  { folder: "inbox", path: "/", icon: InboxIcon },
  { folder: "starred", path: "/starred", icon: StarIcon },
  { folder: "archive", path: "/archive", icon: ArchiveBoxIcon },
  { folder: "trash", path: "/trash", icon: TrashIcon },
];

/** An unread count for a navigation item; nothing when there is none. */
function Unread({ count }: { count: number | undefined }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <Badge
      label={
        <>
          {count > 999 ? "999+" : count}
          <VisuallyHidden>{t("mail.unread")}</VisuallyHidden>
        </>
      }
    />
  );
}

/** The search field in the app bar; `/` focuses it (see useMailShortcuts). */
function SearchField() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const current = useRouterState({
    select: (s) => (s.location.pathname === "/search" ? String(s.location.search.q ?? "") : ""),
  });
  const [query, setQuery] = useState(current);
  useEffect(() => setQuery(current), [current]);
  const submit = () => {
    const q = query.trim();
    if (q) void navigate({ to: "/search", search: { q } });
  };
  return (
    <TextInput
      type="search"
      label={t("mail.search")}
      isLabelHidden
      placeholder={t("mail.searchPlaceholder")}
      startIcon={MagnifyingGlassIcon}
      value={query}
      onChange={setQuery}
      onEnter={submit}
      enterKeyHint="search"
      width="100%"
      htmlName="q"
    />
  );
}

function MailNav() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { counts, addresses } = useMailbox();
  return (
    <SideNav>
      <SideNavSection title={t("nav.mail")} isHeaderHidden>
        {FOLDER_NAV.map(({ folder, path, icon }) => (
          <SideNavItem
            key={folder}
            label={t(`folder.${folder}`)}
            icon={icon}
            isSelected={pathname === path}
            href={path}
            endContent={<Unread count={counts?.folders[folder]} />}
          />
        ))}
      </SideNavSection>
      {addresses.length > 0 && (
        <SideNavSection title={t("nav.addresses")}>
          {addresses.map((a) => (
            <SideNavItem
              key={a.id}
              label={a.address}
              icon={AtSymbolIcon}
              isSelected={pathname === `/address/${a.id}`}
              href={`/address/${a.id}`}
              endContent={<Unread count={counts?.addresses[a.id]} />}
            />
          ))}
        </SideNavSection>
      )}
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
  );
}

/**
 * The signed-in frame: app bar with search, folder and address navigation, the page outlet.
 * When the network comes back the route guard runs again and the mailbox state is rebuilt, so
 * the counts, the socket and the open page load afresh.
 */
export function MailShell() {
  const { t } = useTranslation();
  const router = useRouter();
  const { epoch } = useNetwork();
  useEffect(() => {
    if (epoch > 0) void router.invalidate();
  }, [epoch, router]);
  return (
    <MailboxProvider key={epoch}>
      <AppShell
        banner={<SystemBanners />}
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
            centerContent={<SearchField />}
            endContent={<PreferenceSelectors />}
          />
        }
        sideNav={<MailNav />}
      >
        <Outlet />
      </AppShell>
    </MailboxProvider>
  );
}
