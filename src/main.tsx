import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
      // TanStack refetches every stale query on window focus by default. With
      // ~15 query keys in flight — several of them backed by multi-request forge
      // sweeps, one of them VPN-gated — every alt-tab into the app fired a burst
      // of network calls. Queries that genuinely benefit opt back in explicitly
      // (see `useRefresh`); everything else refreshes on mount, on the sidebar's
      // Refresh button, or on an explicit invalidation.
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
