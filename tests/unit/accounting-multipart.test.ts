import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

it("multipartはJSON化せずboundaryをfetchに任せ、JSON送信も維持する", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response("{}"));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  const form = new FormData();
  form.set("company_id", "1");
  form.set("receipt", new Blob(["fictional pdf"], { type: "application/pdf" }), "sample.pdf");
  await client.post("/api/1/receipts", { body: form });
  expect(fetchFn.mock.calls[0]![1].body).toBe(form);
  expect(fetchFn.mock.calls[0]![1].headers).not.toHaveProperty("Content-Type");
  await client.post("/api/1/deals", { body: { company_id: 1 } });
  expect(fetchFn.mock.calls[1]![1].body).toBe('{"company_id":1}');
  expect(fetchFn.mock.calls[1]![1].headers["Content-Type"]).toBe("application/json");
});
