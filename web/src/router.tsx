import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./App";
import { routeAuthState } from "./api";
import { NARROW } from "./breakpoints";
import type { AstryxMessages, Locale } from "./i18n";

type MailSearch = { m?: string; q?: string; compose?: string; src?: string; kind?: string };

const SEARCH_KEYS = ["m", "q", "compose", "src", "kind"] as const;

// Each page and the signed-in shell are their own chunks, so the first paint loads only what
// the page it shows needs; the sign-in pages do not download the app shell.
export function buildRouter(initialLocale: Locale, initialMessages: AstryxMessages) {
  const rootRoute = createRootRoute({
    component: () => <RootLayout initialLocale={initialLocale} initialMessages={initialMessages} />,
  });

  // Signed-in pages. GET /api/auth/state decides where everyone else goes.
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "shell",
    component: lazyRouteComponent(() => import("./components/MailShell"), "MailShell"),
    beforeLoad: async () => {
      const state = await routeAuthState();
      if (!state) return;
      if (!state.initialized) throw redirect({ to: "/setup" });
      if (!state.authenticated) throw redirect({ to: "/login" });
    },
  });
  // Mailbox views. `m` names the open message, so the browser's back button closes it.
  const mailbox = <P extends string>(path: P, page: keyof typeof import("./pages/MailboxPages")) =>
    createRoute({
      getParentRoute: () => shellRoute,
      path,
      validateSearch: (search: Record<string, unknown>): MailSearch =>
        Object.fromEntries(
          SEARCH_KEYS.flatMap((k) => (typeof search[k] === "string" ? [[k, search[k]]] : [])),
        ),
      component: lazyRouteComponent(() => import("./pages/MailboxPages"), page),
    });
  const mailboxRoutes = [
    mailbox("/", "InboxPage"),
    mailbox("/starred", "StarredPage"),
    mailbox("/sent", "SentPage"),
    mailbox("/drafts", "DraftsPage"),
    mailbox("/archive", "ArchivePage"),
    mailbox("/spam", "SpamPage"),
    mailbox("/trash", "TrashPage"),
    mailbox("/address/$id", "AddressPage"),
    mailbox("/search", "SearchPage"),
  ];
  const settingsIndexRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings",
    // Phones get the list of sections; wider screens open Domains beside the settings navigation.
    beforeLoad: () => {
      if (!matchMedia(NARROW).matches) throw redirect({ to: "/settings/domains", replace: true });
    },
    component: lazyRouteComponent(() => import("./pages/SettingsIndexPage"), "SettingsIndexPage"),
  });
  const securityRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/security",
    component: lazyRouteComponent(() => import("./pages/SecurityPage"), "SecurityPage"),
  });
  const notificationsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/notifications",
    component: lazyRouteComponent(() => import("./pages/NotificationsPage"), "NotificationsPage"),
  });
  const domainsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/domains",
    component: lazyRouteComponent(() => import("./pages/DomainsPage"), "DomainsPage"),
  });
  const domainDnsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/domains/$name",
    component: lazyRouteComponent(() => import("./pages/DomainDnsPage"), "DomainDnsPage"),
  });
  const addressesRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/addresses",
    component: lazyRouteComponent(() => import("./pages/AddressesPage"), "AddressesPage"),
  });
  const forwardingRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/forwarding",
    component: lazyRouteComponent(() => import("./pages/ForwardingPage"), "ForwardingPage"),
  });
  const rulesRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/rules",
    component: lazyRouteComponent(() => import("./pages/RulesPage"), "RulesPage"),
  });
  const apiKeysRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/api-keys",
    component: lazyRouteComponent(() => import("./pages/ApiKeysPage"), "ApiKeysPage"),
  });

  const setupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/setup",
    component: lazyRouteComponent(() => import("./pages/SetupPage"), "SetupPage"),
    beforeLoad: async () => {
      const state = await routeAuthState();
      if (!state) return;
      if (state.initialized) throw redirect({ to: state.authenticated ? "/" : "/login" });
    },
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: lazyRouteComponent(() => import("./pages/LoginPage"), "LoginPage"),
    beforeLoad: async () => {
      const state = await routeAuthState();
      if (!state) return;
      if (!state.initialized) throw redirect({ to: "/setup" });
      if (state.authenticated) throw redirect({ to: "/" });
    },
  });
  const recoverRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/recover",
    component: lazyRouteComponent(() => import("./pages/RecoverPage"), "RecoverPage"),
    beforeLoad: async () => {
      const state = await routeAuthState();
      if (!state) return;
      if (!state.initialized) throw redirect({ to: "/setup" });
      if (state.authenticated) throw redirect({ to: "/" });
    },
  });

  const routeTree = rootRoute.addChildren([
    shellRoute.addChildren([
      ...mailboxRoutes,
      settingsIndexRoute,
      securityRoute,
      notificationsRoute,
      domainsRoute,
      domainDnsRoute,
      addressesRoute,
      forwardingRoute,
      rulesRoute,
      apiKeysRoute,
    ]),
    setupRoute,
    loginRoute,
    recoverRoute,
  ]);
  return createRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
