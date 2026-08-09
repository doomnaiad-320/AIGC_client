// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchViewer,
  mockRegisterWithPassword,
  mockReplace,
} = vi.hoisted(() => ({
  mockFetchViewer: vi.fn().mockResolvedValue({
    workspace: { id: "w1" },
    profile: { id: "u1" },
    membership: { workspaceId: "w1", userId: "u1", role: "owner" },
  }),
  mockRegisterWithPassword: vi.fn().mockResolvedValue({
    session: {
      access_token: "fresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "u1", email: "new-user@example.com", user_metadata: {} },
    },
  }),
  mockReplace: vi.fn(),
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
    registerWithPassword: mockRegisterWithPassword,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
}));

import RegisterPage from "../src/app/register/page";
import { AuthProvider } from "../src/lib/auth-context";

describe("Register page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("creates an account with the local auth API and opens the workspace", async () => {
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "password-123" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(mockRegisterWithPassword).toHaveBeenCalledWith({
        email: "new-user@example.com",
        password: "password-123",
      });
      expect(mockFetchViewer).toHaveBeenCalledWith("fresh-token");
      expect(mockReplace).toHaveBeenCalledWith("/home");
    });
  });

  it("shows a validation error when passwords do not match", async () => {
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "password-123" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "different-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match");
    expect(mockRegisterWithPassword).not.toHaveBeenCalled();
  });
});
