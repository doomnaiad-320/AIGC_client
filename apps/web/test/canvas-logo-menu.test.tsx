// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAdminMe: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mocks.push })),
}));

vi.mock("@/lib/admin-api", () => ({
  fetchAdminMe: mocks.fetchAdminMe,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/hooks/use-create-project", () => ({
  useCreateProject: () => ({ create: vi.fn() }),
}));

vi.mock("@/components/icons/loomic-logo", () => ({
  LoomicLogo: () => <svg aria-label="Loomic" />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import { CanvasLogoMenu } from "../src/components/canvas-logo-menu";

describe("CanvasLogoMenu admin navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the admin page in the canvas menu for a platform administrator", async () => {
    mocks.fetchAdminMe.mockResolvedValue({ isPlatformAdmin: true });
    render(
      <CanvasLogoMenu
        accessToken="session-token"
        projectId="project-1"
        canvasId="canvas-1"
        excalidrawApi={null}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "管理后台" }),
    ).toBeInTheDocument();
  });

  it("does not show the admin page in the canvas menu for a standard user", async () => {
    mocks.fetchAdminMe.mockResolvedValue({ isPlatformAdmin: false });
    render(
      <CanvasLogoMenu
        accessToken="session-token"
        projectId="project-1"
        canvasId="canvas-1"
        excalidrawApi={null}
      />,
    );

    await waitFor(() => {
      expect(mocks.fetchAdminMe).toHaveBeenCalledWith("session-token");
    });
    expect(
      screen.queryByRole("button", { name: "管理后台" }),
    ).not.toBeInTheDocument();
  });
});
