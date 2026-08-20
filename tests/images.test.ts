/**
 * Image generation: which connections can do it, and what the model is told.
 *
 * The test that matters most here is the last group. A generated image is
 * megabytes of base64, and it has to be in the stored message and *not* in the
 * next request's context window. That separation is entirely `toModelOutput`'s
 * doing, and it is applied by `convertToModelMessages` rather than by the tool
 * itself — so it only works if every caller rebuilding history passes the tool
 * set to the conversion. That is easy to forget, silent when forgotten, and
 * expensive; hence a test.
 */

import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { canGenerateImages, imageKindFor } from "../src/server/images/catalog.js";
import { resolveImageModel } from "../src/server/images/registry.js";
import { imageTools } from "../src/server/images/tools.js";
import type { Connection } from "../src/server/db/schema.js";

/** A key variable that is actually set, the way a working connection has one. */
const KEY_ENV = "MODELDOCK_TEST_IMAGE_KEY";
process.env[KEY_ENV] = "test-key";

const connection = (kind: Connection["kind"], extra: Partial<Connection> = {}): Connection =>
  ({
    id: "c1",
    name: "Test",
    kind,
    baseUrl: "http://localhost:1234/v1",
    model: "m",
    apiKeyEnv: KEY_ENV,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...extra,
  }) as Connection;

describe("which kinds can draw", () => {
  it("offers the three that publish an image model", () => {
    expect(canGenerateImages("openai")).toBe(true);
    expect(canGenerateImages("google")).toBe(true);
    expect(canGenerateImages("openai_compatible")).toBe(true);
  });

  /**
   * Not a gap to be filled in later. Anthropic has no image model, and saying
   * so as data is what lets the picker leave it out instead of offering a
   * choice that 404s.
   */
  it("does not offer Anthropic", () => {
    expect(canGenerateImages("anthropic")).toBe(false);
    expect(imageKindFor("anthropic")).toBeUndefined();
  });
});

describe("resolving an image model", () => {
  it("builds one for each kind that can draw", () => {
    expect(resolveImageModel(connection("openai"), "gpt-image-1")).toBeTruthy();
    expect(resolveImageModel(connection("google"), "imagen-4.0-generate-001")).toBeTruthy();
    expect(resolveImageModel(connection("openai_compatible"), "sd-xl")).toBeTruthy();
  });

  it("falls back to the kind's default model", () => {
    expect(resolveImageModel(connection("openai"))).toBeTruthy();
  });

  it("explains that Anthropic cannot, and says what to do instead", () => {
    expect(() => resolveImageModel(connection("anthropic"), "whatever")).toThrow(
      /does not offer an image model/i,
    );
  });

  it("refuses a local endpoint with no model named", () => {
    expect(() => resolveImageModel(connection("openai_compatible"))).toThrow(/no image model set/i);
  });

  it("refuses an OpenAI-shaped endpoint with no base URL", () => {
    expect(() =>
      resolveImageModel(connection("openai_compatible", { baseUrl: null }), "sd"),
    ).toThrow(/needs a base URL/i);
  });
});

/**
 * The context-window guarantee.
 *
 * A message carrying a generated image is replayed through
 * `convertToModelMessages` exactly as `routes/chat.ts` does it, and the result
 * is searched for the base64. Finding it would mean every subsequent turn in
 * that conversation pays for the image again.
 */
describe("what the model is told about a generated image", () => {
  const tools = imageTools({
    engine: { connection: connection("openai"), model: "gpt-image-1" },
  });

  /** Stands in for real PNG bytes; long enough to be unmistakable in a haystack. */
  const base64 = "iVBORw0KGgoAAAANS".repeat(40);

  const history: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "draw a heron" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-generate_image",
          toolCallId: "call1",
          state: "output-available",
          input: { prompt: "a heron", size: "1024x1024", n: 1 },
          output: {
            prompt: "a heron",
            model: "gpt-image-1",
            size: "1024x1024",
            images: [{ url: `data:image/png;base64,${base64}`, mediaType: "image/png" }],
          },
        },
      ],
    } as unknown as UIMessage,
  ];

  it("keeps the image bytes out of the model's context", async () => {
    const messages = await convertToModelMessages(history, { tools });
    const wire = JSON.stringify(messages);

    expect(wire).not.toContain(base64);
    expect(wire.length).toBeLessThan(1000);
  });

  it("tells it an image was made, and not to describe it back", async () => {
    const messages = await convertToModelMessages(history, { tools });
    const wire = JSON.stringify(messages);

    expect(wire).toContain("gpt-image-1");
    expect(wire).toMatch(/already shown/i);
  });

  /**
   * The failure this guards against. Without the tool set the conversion has
   * no `toModelOutput` to apply, so the whole result — base64 and all — is sent
   * as JSON. Asserting the bad path explicitly is what makes the good one
   * meaningful rather than incidental.
   */
  it("would send the whole payload if the tool set were not passed", async () => {
    const messages = await convertToModelMessages(history);
    expect(JSON.stringify(messages)).toContain(base64);
  });

  it("passes a failure through as the message the person should see", async () => {
    const failed: UIMessage[] = [
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "tool-generate_image",
            toolCallId: "call2",
            state: "output-available",
            input: { prompt: "x", size: "1024x1024", n: 1 },
            output: { error: "OPENAI_API_KEY is not set in this environment." },
          },
        ],
      } as unknown as UIMessage,
    ];

    const messages = await convertToModelMessages(failed, { tools });
    expect(JSON.stringify(messages)).toContain("OPENAI_API_KEY is not set");
  });
});
