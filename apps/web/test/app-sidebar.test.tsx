// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  signOut: vi.fn(),
  fetchAdminMe: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/home"),
  useRouter: vi.fn(() => ({ replace: mocks.replace })),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: vi.fn(() => ({
    session: { access_token: "session-token" },
    signOut: mocks.signOut,
  })),
}));

vi.mock("@/lib/admin-api", () => ({
  fetchAdminMe: mocks.fetchAdminMe,
}));

vi.mock("@/components/credits/credit-balance", () => ({
  CreditBalance: () => <div data-testid="credit-balance" />,
}));

vi.mock("@/components/icons/loomic-logo", () => ({
  LoomicLogo: () => <svg aria-label="Loomic" />,
}));

import { AppSidebar } from "../src/components/app-sidebar";

describe("AppSidebar admin navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the admin console entry to a platform administrator", async () => {
    mocks.fetchAdminMe.mockResolvedValue({ isPlatformAdmin: true });
    render(<AppSidebar />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("link", { name: "Admin Console" }),
      ).toHaveLength(2);
    });
    expect(mocks.fetchAdminMe).toHaveBeenCalledWith("session-token");
  });

  it("does not show the admin console entry to a standard user", async () => {
    mocks.fetchAdminMe.mockResolvedValue({ isPlatformAdmin: false });
    render(<AppSidebar />);

    await waitFor(() => {
      expect(mocks.fetchAdminMe).toHaveBeenCalledWith("session-token");
    });
    expect(
      screen.queryByRole("link", { name: "Admin Console" }),
    ).not.toBeInTheDocument();
  });
});
