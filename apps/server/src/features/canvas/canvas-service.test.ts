import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../../auth/user.js";
import { createCanvasService } from "./canvas-service.js";

const user: AuthenticatedUser = {
  accessToken: "test-token",
  authVersion: 0,
  email: "test@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};

describe("CanvasService private asset references", () => {
  it("hydrates an asset marker with a fresh signed URL", async () => {
    const canvasQuery = {
      eq: vi.fn(),
      select: vi.fn(),
      single: vi.fn().mockResolvedValue({
        data: {
          content: {
            appState: {},
            elements: [
              {
                customData: {
                  assetId: "44444444-4444-4444-8444-444444444444",
                  isVideo: true,
                },
                id: "video-element",
                link: "asset://44444444-4444-4444-8444-444444444444",
                type: "embeddable",
              },
            ],
            files: {},
          },
          id: "33333333-3333-4333-8333-333333333333",
          name: "Canvas",
          project_id: "22222222-2222-4222-8222-222222222222",
        },
        error: null,
      }),
    };
    canvasQuery.select.mockReturnValue(canvasQuery);
    canvasQuery.eq.mockReturnValue(canvasQuery);

    const assetQuery = {
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          bucket: "project-assets",
          object_path: "workspace/generated/video.mp4",
        },
        error: null,
      }),
      select: vi.fn(),
    };
    assetQuery.select.mockReturnValue(assetQuery);
    assetQuery.eq.mockReturnValue(assetQuery);

    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "http://localhost/video.mp4?token=fresh" },
      error: null,
    });
    const service = createCanvasService({
      createUserClient: vi.fn(
        () =>
          ({
            from: vi.fn((table: string) =>
              table === "canvases" ? canvasQuery : assetQuery,
            ),
            storage: {
              from: vi.fn(() => ({ createSignedUrl })),
            },
          }) as any,
      ),
    });

    const canvas = await service.getCanvas(
      user,
      "33333333-3333-4333-8333-333333333333",
    );
    const element = canvas.content.elements[0]!;

    expect(element.link).toBe("http://localhost/video.mp4?token=fresh");
    expect(element.customData).toMatchObject({
      assetId: "44444444-4444-4444-8444-444444444444",
      storageBucket: "project-assets",
      storageObjectPath: "workspace/generated/video.mp4",
    });
  });

  it("stores a stable asset marker instead of an expiring video URL", async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: null });
    const update = vi.fn(() => ({ eq }));
    const service = createCanvasService({
      createUserClient: vi.fn(
        () =>
          ({
            from: vi.fn(() => ({ update })),
            storage: { from: vi.fn() },
          }) as any,
      ),
    });

    await service.saveCanvasContent(
      user,
      "33333333-3333-4333-8333-333333333333",
      {
        appState: {},
        elements: [
          {
            customData: {
              assetId: "44444444-4444-4444-8444-444444444444",
              isVideo: true,
            },
            id: "video-element",
            link: "http://localhost/video.mp4?token=expiring",
            type: "embeddable",
          },
        ],
        files: {},
      },
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          elements: [
            expect.objectContaining({
              link: "asset://44444444-4444-4444-8444-444444444444",
            }),
          ],
        }),
      }),
    );
  });
});
