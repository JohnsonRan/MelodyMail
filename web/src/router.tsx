import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./App";
import { getAuthState } from "./api";
import type { AstryxMessages, Locale } from "./i18n";

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
      const state = await getAuthState();
      if (!state.initialized) throw redirect({ to: "/setup" });
      if (!state.authenticated) throw redirect({ to: "/login" });
    },
  });
  const inboxRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/",
    component: lazyRouteComponent(() => import("./pages/InboxPage"), "InboxPage"),
  });
  const securityRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/settings/security",
    component: lazyRouteComponent(() => import("./pages/SecurityPage"), "SecurityPage"),
  });

  const setupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/setup",
    component: lazyRouteComponent(() => import("./pages/SetupPage"), "SetupPage"),
    beforeLoad: async () => {
      const state = await getAuthState();
      if (state.initialized) throw redirect({ to: state.authenticated ? "/" : "/login" });
    },
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: lazyRouteComponent(() => import("./pages/LoginPage"), "LoginPage"),
    beforeLoad: async () => {
      const state = await getAuthState();
      if (!state.initialized) throw redirect({ to: "/setup" });
      if (state.authenticated) throw redirect({ to: "/" });
    },
  });
  const recoverRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/recover",
    component: lazyRouteComponent(() => import("./pages/RecoverPage"), "RecoverPage"),
    beforeLoad: async () => {
      const state = await getAuthState();
      if (!state.initialized) throw redirect({ to: "/setup" });
      if (state.authenticated) throw redirect({ to: "/" });
    },
  });

  const routeTree = rootRoute.addChildren([
    shellRoute.addChildren([inboxRoute, securityRoute]),
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
