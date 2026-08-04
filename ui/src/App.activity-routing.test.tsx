// @vitest-environment jsdom

// Regression guard for PAP-16302: `/audit` was merged into the single rich
// Activity page. Both the company-prefixed `/:company/audit` and the bare
// `/audit` (PAP-16300's unprefixed redirect) must keep resolving — as redirects
// into `/:company/activity?mode=agents`, so old deep links land on the
// agent-actions scope instead of 404ing. This drives the real <App> route table
// so removing either registration fails loudly.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papActivityRoutingPatched?: boolean;
  };
  if (!sheetProto.__papActivityRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap16302-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papActivityRoutingPatched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// Rendered by <App> outside <Routes> and needs DialogProvider; irrelevant here.
vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Cloud access is unrelated to the route-table regression. Let it fall through
// synchronously so this test does not poll its query transitions.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// Sentinel page that also reports the resolved path + query, so we can assert
// the merged route *and* the preset mode a redirect carried into it.
vi.mock("./pages/audit/CompanyActivity", () => ({
  CompanyActivity: () => {
    const location = useLocation();
    return <div>{`ACTIVITY_PAGE@${location.pathname}${location.search}`}</div>;
  },
}));

const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

async function waitForRoute(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  expect(container.textContent).toContain(text);
}

describe("App Activity routing (PAP-16302)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("serves the merged Activity page at /:company/activity", async () => {
    const root = renderAppAt(container, "/PAP/activity");
    await waitForRoute(container, "ACTIVITY_PAGE@/PAP/activity");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });

  it("redirects /:company/audit to Activity with the agent-actions mode preset", async () => {
    const root = renderAppAt(container, "/PAP/audit");
    await waitForRoute(container, "ACTIVITY_PAGE@/PAP/activity?mode=agents");
    flushSync(() => root.unmount());
  });

  it("redirects the bare /audit deep link through to the prefixed Activity page", async () => {
    const root = renderAppAt(container, "/audit");
    await waitForRoute(container, "ACTIVITY_PAGE@/PAP/activity?mode=agents");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });
});
