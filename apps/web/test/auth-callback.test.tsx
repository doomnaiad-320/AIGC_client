// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
}));

import CallbackPage from "../src/app/auth/callback/page";

describe("Auth callback page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("redirects disabled external auth callbacks to password login", async () => {
    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        "/login?error=auth_callback_disabled",
      );
    });
  });
});
