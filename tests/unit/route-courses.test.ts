import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/courses/route";
import * as service from "@/lib/service";

describe("POST /api/courses route error classification", () => {
  it("maps unexpected internal faults to 500 while logging appropriately", async () => {
    const spy = vi.spyOn(service, "createCourse").mockRejectedValueOnce(new Error("Disk I/O error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const req = new NextRequest("http://127.0.0.1:3000/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sample: true }),
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Disk I/O error");
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it("maps MaterialNotViableError to 422 without logging as a server fault", async () => {
    const spy = vi
      .spyOn(service, "createCourse")
      .mockRejectedValueOnce(new service.MaterialNotViableError("Controlled viability failure"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const req = new NextRequest("http://127.0.0.1:3000/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sample: true }),
      });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Controlled viability failure");
      // Must not be logged as an unexpected server fault.
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
