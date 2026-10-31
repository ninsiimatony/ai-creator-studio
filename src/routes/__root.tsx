import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { StudioProvider, demoSnapshot } from "@/lib/studio-store";
import { AppShell } from "@/components/AppShell";
import { AuthScreen } from "@/components/AuthScreen";
import { getSession, loadData } from "@/lib/api.functions";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Plan, script, produce and approve faceless AI explainer videos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Sora:wght@500;600;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 text-center">
      <div role="status" className="text-sm text-muted-foreground">
        {children ?? "Loading…"}
      </div>
    </div>
  );
}

/** Decides between demo mode (no database), sign-in, and the signed-in studio. */
function SessionGate() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: () => getSession(), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ["session"] });
  const signedIn = session.data?.mode === "db" && !!session.data.user;
  const data = useQuery({
    queryKey: ["studio-data"],
    queryFn: () => loadData(),
    enabled: signedIn,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  if (session.isPending) return <Splash />;
  if (session.isError || !session.data) {
    return (
      <Splash>
        <p>We couldn't reach the server.</p>
        <button className="btn mt-3" onClick={() => session.refetch()}>
          Try again
        </button>
      </Splash>
    );
  }
  const info = session.data;

  if (info.mode === "demo") {
    return (
      <StudioProvider mode="demo" initial={demoSnapshot}>
        <AppShell>
          <Outlet />
        </AppShell>
      </StudioProvider>
    );
  }
  if (!info.user) {
    return (
      <AuthScreen
        setupOpen={info.setupOpen}
        setupConfigured={info.setupConfigured}
        onDone={refresh}
      />
    );
  }
  if (data.isError) {
    return (
      <Splash>
        <p>We couldn't load your data.</p>
        <button className="btn mt-3" onClick={() => data.refetch()}>
          Try again
        </button>
      </Splash>
    );
  }
  if (!data.data) return <Splash />;
  return (
    <StudioProvider
      key={info.user.email}
      mode="db"
      initial={data.data}
      userEmail={info.user.email}
      onSignOut={() => {
        qc.removeQueries({ queryKey: ["studio-data"] });
        void refresh();
      }}
      onSessionExpired={() => {
        qc.removeQueries({ queryKey: ["studio-data"] });
        void refresh();
      }}
    >
      <AppShell>
        <Outlet />
      </AppShell>
    </StudioProvider>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <SessionGate />
    </QueryClientProvider>
  );
}
