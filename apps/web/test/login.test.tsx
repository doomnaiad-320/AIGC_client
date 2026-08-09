// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchViewer,
  mockLoginWithPassword,
  mockReplace,
  mockSearchParams,
} = vi.hoisted(() => ({
  mockFetchViewer: vi.fn().mockResolvedValue({
    workspace: { id: "w1" },
    profile: { id: "u1" },
    membership: { workspaceId: "w1", userId: "u1", role: "owner" },
  }),
  mockLoginWithPassword: vi.fn().mockResolvedValue({
    session: {
      access_token: "session-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "u1", email: "user@example.com", user_metadata: {} },
    },
  }),
  mockReplace: vi.fn(),
  mockSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("../src/lib/server-api", () => {
  class ApiAuthError extends Error {}
  class ApiApplicationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  return {
    ApiApplicationError,
    ApiAuthError,
    fetchViewer: mockFetchViewer,
    loginWithPassword: mockLoginWithPassword,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
  useSearchParams: mockSearchParams,
}));

import LoginPage from "../src/app/login/page";
import { AuthProvider } from "../src/lib/auth-context";

describe("Login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockSearchParams.mockReturnValue(new URLSearchParams());
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders split screen with brand panel and password login form", async () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect((await screen.findByText("Loomic")).textContent).toBe("Loomic");
    expect(screen.getByText(/Sign in with email and password/i).textContent).toContain(
      "Sign in with email and password",
    );
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create one/i }).getAttribute("href")).toBe("/register");
  });

  it("shows callback errors from the query string as a banner", async () => {
    mockSearchParams.mockReturnValue(new URLSearchParams("error=auth_exchange_failed"));

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This sign-in link could not be verified. Request a new one and try again.",
    );
  });

  it("bootstraps the viewer before redirecting after password sign-in", async () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(mockLoginWithPassword).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "password-123",
      });
      expect(mockFetchViewer).toHaveBeenCalledWith("session-token");
      expect(mockReplace).toHaveBeenCalledWith("/home");
    });
  });
});
