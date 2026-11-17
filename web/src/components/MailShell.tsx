import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { VStack } from "@astryxdesign/core/Layout";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowUturnRightIcon,
  AtSymbolIcon,
  BellIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  FunnelIcon,
  GlobeAltIcon,
  InboxIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  ShieldCheckIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NARROW } from "../breakpoints";
import type { Folder } from "../mailbox/api";
import { MailboxProvider, useMailbox } from "../mailbox/MailboxContext";
import { useNetwork } from "../network";
import { PreferenceSelectors } from "../preferences";
import { AppLogo } from "./AppLogo";
import { SystemBanners } from "./SystemBanners";

/**
 * The end of a navigation drawer on phones: the language and theme selectors, which leave the
 * compact app bar there so the app name is not cut.
 */
function DrawerPreferences({ children }: { children?: ReactNode }) {
  const narrow = useMediaQuery(NARROW);
  if (!narrow) return children;
  return (
    <VStack gap={4} hAlign="stretch">
      {children}
      <PreferenceSelectors isStacked />
    </VStack>
  );
}

const FOLDER_NAV: { folder: Folder | "drafts"; path: string; icon: typeof InboxIcon }[] = [
  { folder: "inbox", path: "/", icon: InboxIcon },
  { folder: "starred", path: "/starred", icon: StarIcon },
  { folder: "sent", path: "/sent", icon: PaperAirplaneIcon },
  { folder: "drafts", path: "/drafts", icon: DocumentTextIcon },
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
    <SideNav
      footer={
        <DrawerPreferences>
          <SideNavItem
            label={t("nav.settings")}
            icon={Cog6ToothIcon}
            isSelected={false}
            href="/settings"
          />
        </DrawerPreferences>
      }
    >
      <SideNavSection title={t("nav.mail")} isHeaderHidden>
        {FOLDER_NAV.map(({ folder, path, icon }) => (
          <SideNavItem
            key={folder}
            label={t(`folder.${folder}`)}
            icon={icon}
            isSelected={pathname === path}
            href={path}
            endContent={folder === "drafts" ? null : <Unread count={counts?.folders[folder]} />}
          />
        ))}
      </SideNavSection>
      {addresses.length > 0 && (
        <SideNavSection title={t("nav.receivingAddresses")}>
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
    </SideNav>
  );
}

export const SETTINGS_NAV: {
  title: string;
  items: { key: string; path: string; icon: typeof InboxIcon }[];
}[] = [
  {
    title: "nav.mail",
    items: [
      { key: "domains", path: "/settings/domains", icon: GlobeAltIcon },
      { key: "addresses", path: "/settings/addresses", icon: AtSymbolIcon },
      { key: "forwarding", path: "/settings/forwarding", icon: ArrowUturnRightIcon },
      { key: "rules", path: "/settings/rules", icon: FunnelIcon },
    ],
  },
  {
    title: "nav.notifications",
    items: [{ key: "notifications", path: "/settings/notifications", icon: BellIcon }],
  },
  {
    title: "nav.account",
    items: [
      { key: "security", path: "/settings/security", icon: ShieldCheckIcon },
      { key: "apiKeys", path: "/settings/api-keys", icon: KeyIcon },
    ],
  },
];

/** The side navigation of every /settings page: a way back, then the settings in groups. */
function SettingsNav() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <SideNav footer={<DrawerPreferences />}>
      <SideNavSection title={t("nav.backToMailbox")} isHeaderHidden>
        <SideNavItem label={t("nav.backToMailbox")} icon={ArrowLeftIcon} href="/" />
      </SideNavSection>
      {SETTINGS_NAV.map(({ title, items }) => (
        <SideNavSection key={title} title={t(title)}>
          {items.map(({ key, path, icon }) => (
            <SideNavItem
              key={key}
              label={t(`nav.${key}`)}
              icon={icon}
              isSelected={pathname === path || pathname.startsWith(`${path}/`)}
              href={path}
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  );
}

/**
 * The signed-in frame: app bar with search, the mailbox navigation or, under /settings, the settings navigation, the page outlet.
 * When the network comes back the route guard runs again and the mailbox state is rebuilt, so
 * the counts, the socket and the open page load afresh.
 */
export function MailShell() {
  const { t } = useTranslation();
  const router = useRouter();
  const inSettings = useRouterState({ select: (s) => s.location.pathname.startsWith("/settings") });
  const { epoch } = useNetwork();
  const narrow = useMediaQuery(NARROW);
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
            heading={<TopNavHeading heading={t("app.name")} logo={<AppLogo size="md" />} />}
            centerContent={<SearchField />}
            endContent={narrow ? null : <PreferenceSelectors />}
          />
        }
        sideNav={inSettings ? <SettingsNav /> : <MailNav />}
      >
        <Outlet />
      </AppShell>
    </MailboxProvider>
  );
}
