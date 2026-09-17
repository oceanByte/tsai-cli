import { describe, expect, test } from "bun:test";
import { APIError } from "@typesafe-ai/sdk";
import { exitCodeForStatus, normalizeError, parseErrorBody } from "../src/core/errors.ts";
import { CliError, EXIT, gateError, usageError } from "../src/core/exit.ts";

const headers = (id?: string) => new Headers(id ? { "x-typesafe-request-id": id } : {});

describe("parseErrorBody", () => {
  test("shape 1: detail is an object carrying error_type and message", () => {
    const parsed = parseErrorBody({
      detail: { error_type: "authentication_error", message: "Cannot authenticate." },
    });
    expect(parsed.type).toBe("authentication_error");
    expect(parsed.message).toBe("Cannot authenticate.");
    expect(parsed.issues).toBeUndefined();
  });

  test("shape 2: detail is a bare string", () => {
    const parsed = parseErrorBody({ detail: "Too many choices. Must have at most 255 choices." });
    expect(parsed.message).toBe("Too many choices. Must have at most 255 choices.");
    expect(parsed.type).toBeUndefined();
  });

  test("shape 3: detail is an array of field issues", () => {
    const parsed = parseErrorBody({
      detail: [
        { type: "missing", loc: ["body", "questions"], msg: "Field required" },
        { type: "missing", loc: ["body", "state"], msg: "Field required" },
      ],
    });
    expect(parsed.type).toBe("validation_error");
    expect(parsed.issues).toEqual([
      { path: "questions", message: "Field required" },
      { path: "state", message: "Field required" },
    ]);
    expect(parsed.message).toBe("questions: Field required; state: Field required");
  });

  test("the leading body segment is dropped, and an empty loc becomes (request)", () => {
    const parsed = parseErrorBody({ detail: [{ loc: ["body"], msg: "Field required" }] });
    expect(parsed.issues?.[0]?.path).toBe("(request)");
  });

  test("a plain string body is treated as the message", () => {
    expect(parseErrorBody("upstream exploded").message).toBe("upstream exploded");
  });

  test("null, undefined and unrecognised bodies yield nothing rather than throwing", () => {
    expect(parseErrorBody(null)).toEqual({});
    expect(parseErrorBody(undefined)).toEqual({});
    expect(parseErrorBody({ unexpected: true })).toEqual({});
    expect(parseErrorBody("   ")).toEqual({});
  });
});

describe("exitCodeForStatus", () => {
  test.each([
    [400, EXIT.USAGE],
    [401, EXIT.AUTH],
    [403, EXIT.AUTH],
    [404, EXIT.USAGE],
    [422, EXIT.USAGE],
    [429, EXIT.RATE_LIMIT],
    [500, EXIT.SERVER],
    [529, EXIT.SERVER],
  ])("HTTP %i maps to exit %i", (status, code) => {
    expect(exitCodeForStatus(status)).toBe(code);
  });
});

describe("normalizeError", () => {
  test("a usage error keeps its code, message and hint", () => {
    const { normalized, code } = normalizeError(usageError("Bad flag.", "Try --help."));
    expect(code).toBe(EXIT.USAGE);
    expect(normalized).toMatchObject({ type: "usage_error", message: "Bad flag.", hint: "Try --help." });
  });

  test("a gate failure is typed gate_not_met and merges its details", () => {
    const { normalized, code } = normalizeError(gateError("Below threshold.", { observed: 0.3 }));
    expect(code).toBe(EXIT.GATE);
    expect(normalized.type).toBe("gate_not_met");
    expect((normalized as unknown as Record<string, unknown>).observed).toBe(0.3);
  });

  test("an API error surfaces the request id alongside the server's message", () => {
    const error = new APIError(
      401,
      { detail: { error_type: "authentication_error", message: "Cannot authenticate." } },
      headers("req_abc"),
    );
    const { normalized, code } = normalizeError(error);
    expect(code).toBe(EXIT.AUTH);
    expect(normalized.message).toBe("Cannot authenticate.");
    expect(normalized.status).toBe(401);
    expect(normalized.request_id).toBe("req_abc");
    expect(normalized.hint).toContain("tsai auth");
  });

  test("a 400 over the choice limit carries the windowing hint", () => {
    const error = new APIError(400, { detail: "Too many choices. Must have at most 255 choices." }, headers());
    const { normalized, code } = normalizeError(error);
    expect(code).toBe(EXIT.USAGE);
    expect(normalized.hint).toContain("Split the options");
  });

  test("a 422 keeps the per-field issues", () => {
    const error = new APIError(422, { detail: [{ loc: ["body", "state"], msg: "Field required" }] }, headers());
    const { normalized } = normalizeError(error);
    expect(normalized.issues).toEqual([{ path: "state", message: "Field required" }]);
  });

  test("an unknown thrown value becomes an internal error rather than crashing", () => {
    const { normalized, code } = normalizeError("something odd");
    expect(code).toBe(EXIT.INTERNAL);
    expect(normalized.message.length).toBeGreaterThan(0);
  });

  test("a CliError subclass instance round-trips its exit code", () => {
    const { code } = normalizeError(new CliError(EXIT.CONNECTION, "socket closed"));
    expect(code).toBe(EXIT.CONNECTION);
  });
});
