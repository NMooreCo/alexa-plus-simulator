import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_CALLS, parseCalls, runChecks, type CheckOptions, type ToolCall } from "../src/check/index.ts";
import { BOOKING_TOOL, FORECAST_TOOL, fakeServer, type FakeTool } from "./fakes.ts";

const SERVER_URL = "https://addon.example.com/mcp";
const MISSING = "alexa_plus_simulator_no_such_tool_";
const TOKEN = "test-token-123";

async function check(server: { fetch: CheckOptions["fetch"]; now?: () => number }, options: Partial<CheckOptions> = {}) {
  const report = await runChecks({ serverUrl: SERVER_URL, fetch: server.fetch, now: server.now ?? (() => 0), timeoutMs: 2000, ...options });
  const rule = (id: string) => report.rules.find((r) => r.id === id)!;
  return { report, rule };
}

/** A read-only tool that needs an argument, so the check never calls it on its own. */
const CITY_TOOL: FakeTool = {
  name: "get_city_forecast",
  description: "A city's forecast.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  annotations: { readOnlyHint: true },
  result: { content: [{ type: "text", text: "Sunny in Denver." }], structuredContent: { city: "Denver", summary: "Sunny" } },
};
const DENVER: ToolCall = { tool: "get_city_forecast", arguments: { city: "Denver" } };
const DENVER_LABEL = `get_city_forecast({"city":"Denver"})`;
const BOOKING: ToolCall = { tool: "book_table", arguments: { when: "7pm" } };

/** The tools/call requests the server got, as "name arguments", leaving out the made-up tool. */
const callsMade = (server: ReturnType<typeof fakeServer>) =>
  server
    .requests()
    .filter((r) => r.method === "tools/call")
    .map((r) => r.params as { name: string; arguments: unknown })
    .filter((p) => !p.name.startsWith(MISSING))
    .map((p) => `${p.name} ${JSON.stringify(p.arguments)}`);

describe("listed calls", () => {
  it("makes a listed call to a tool that isn't read-only, once, and never an unlisted one", async () => {
    const cancel: FakeTool = { ...BOOKING_TOOL, name: "cancel_table", description: "Cancels a booking." };
    const server = fakeServer({ tools: [BOOKING_TOOL, cancel] });
    const { rule } = await check(server, { calls: [BOOKING] });
    expect(callsMade(server)).toEqual([`book_table {"when":"7pm"}`]);
    // Its result has text but no structuredContent, and the note names the call with its arguments.
    expect(rule("DL-05")).toMatchObject({ status: "WARN", notes: expect.stringContaining(`The call to book_table({"when":"7pm"}) returned text content but no structuredContent`) });
    expect(rule("DL-07")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("None of the calls made was to a tool marked read-only") });
  });

  it("repeats a listed call to a read-only tool, and times both", async () => {
    const server = fakeServer({ tools: [CITY_TOOL] });
    const { rule } = await check(server, { calls: [DENVER] });
    expect(callsMade(server)).toEqual([`get_city_forecast {"city":"Denver"}`, `get_city_forecast {"city":"Denver"}`]);
    expect(rule("DL-05")).toMatchObject({ status: "PASS", notes: `The call to ${DENVER_LABEL} returned text content and structuredContent.` });
    expect(rule("DL-07")).toMatchObject({ status: "PASS", notes: `Two calls to ${DENVER_LABEL} with the same arguments returned the same result.` });
    // initialize, three listings and the two calls.
    expect(rule("DL-04").notes).toContain("over 6 round trips");
  });

  it("judges the check's own pick and every listed call, naming each", async () => {
    const server = fakeServer({ tools: [FORECAST_TOOL, CITY_TOOL, BOOKING_TOOL] });
    const boulder: ToolCall = { tool: "get_city_forecast", arguments: { city: "Boulder" } };
    const { rule } = await check(server, { calls: [DENVER, boulder, BOOKING] });
    expect(callsMade(server)).toEqual([
      "get_forecast {}",
      "get_forecast {}",
      `get_city_forecast {"city":"Denver"}`,
      `get_city_forecast {"city":"Denver"}`,
      `get_city_forecast {"city":"Boulder"}`,
      `get_city_forecast {"city":"Boulder"}`,
      `book_table {"when":"7pm"}`,
    ]);
    // Only the booking's result lacks structuredContent, so only it is named in the warning.
    expect(rule("DL-05").status).toBe("WARN");
    expect(rule("DL-05").notes).toContain(`book_table({"when":"7pm"})`);
    expect(rule("DL-05").notes).not.toContain("get_forecast");
    expect(rule("DL-07")).toMatchObject({
      status: "PASS",
      notes: `Each read-only call, made twice with the same arguments, returned the same result: get_forecast; ${DENVER_LABEL}; get_city_forecast({"city":"Boulder"}).`,
    });
  });

  it("fails DL-05 for a listed call that reports an error, quoting it, and leaves it out of DL-07", async () => {
    const broken: FakeTool = { ...CITY_TOOL, result: { content: [{ type: "text", text: "Unknown city" }], isError: true } };
    const { rule } = await check(fakeServer({ tools: [FORECAST_TOOL, broken] }), { calls: [DENVER] });
    expect(rule("DL-05")).toMatchObject({ status: "FAIL", notes: `The call to ${DENVER_LABEL} reported an error: Unknown city.` });
    expect(rule("DL-07")).toMatchObject({
      status: "PASS",
      notes: `Two calls to get_forecast with the same arguments returned the same result. One call wasn't compared, since the first try didn't succeed (see DL-05).`,
    });
  });

  it("warns about each listed read-only call whose answer changes, saying where", async () => {
    const changing: FakeTool = { ...CITY_TOOL, results: (n) => ({ content: [{ type: "text", text: `Reading ${n}` }], structuredContent: { reading: n } }) };
    const { rule } = await check(fakeServer({ tools: [FORECAST_TOOL, changing] }), { calls: [DENVER] });
    expect(rule("DL-07")).toMatchObject({
      status: "WARN",
      notes: `Two calls to ${DENVER_LABEL} with the same arguments returned different results, at content[0].text; structuredContent.reading. The other repeated call returned the same result.`,
    });
  });

  it("says to give it sample calls when no tool can be called on its own", async () => {
    const { rule } = await check(fakeServer({ tools: [BOOKING_TOOL, CITY_TOOL] }));
    for (const id of ["DL-05", "DL-07"]) {
      expect(rule(id)).toMatchObject({ status: "SKIP", notes: expect.stringContaining("give it sample calls with --calls") });
    }
  });

  it("doesn't call a listed tool the server doesn't list, and says so", async () => {
    const server = fakeServer({ tools: [FORECAST_TOOL] });
    const { rule } = await check(server, { calls: [{ tool: "get_forcast" }] });
    expect(callsMade(server)).toEqual(["get_forecast {}", "get_forecast {}"]);
    expect(rule("DL-05")).toMatchObject({ status: "PASS", notes: expect.stringContaining("Not called, since the server doesn't list it: get_forcast.") });
  });

  it("calls the check's own pick only twice when it's listed too", async () => {
    const server = fakeServer({ tools: [FORECAST_TOOL] });
    await check(server, { calls: [{ tool: "get_forecast" }, { tool: "get_forecast", arguments: {} }] });
    expect(callsMade(server)).toEqual(["get_forecast {}", "get_forecast {}"]);
  });

  it("doesn't time a read-only tool again on its own once a listed call made the same call", async () => {
    const other: FakeTool = { ...FORECAST_TOOL, name: "get_alerts", _meta: undefined };
    const server = fakeServer({ tools: [FORECAST_TOOL, other] });
    await check(server, { calls: [{ tool: "get_alerts" }] });
    expect(callsMade(server)).toEqual(["get_forecast {}", "get_forecast {}", "get_alerts {}", "get_alerts {}"]);
  });

  it("reads a screen named in a listed call's result", async () => {
    const withScreen: FakeTool = {
      ...CITY_TOOL,
      result: { content: [{ type: "text", text: "Sunny." }], structuredContent: { summary: "Sunny" }, _meta: { ui: { resourceUri: "ui://city" } } },
    };
    const server = fakeServer({ tools: [withScreen], resources: { "ui://city": { mimeType: "text/html;profile=mcp-app", text: "<p>Sunny</p>" } } });
    const { rule } = await check(server, { calls: [DENVER] });
    expect(rule("DL-08")).toMatchObject({ status: "PASS", notes: expect.stringContaining("ui://city (text/html;profile=mcp-app)") });
  });

  it("names a slow listed call in DL-04, with its arguments", async () => {
    const server = fakeServer({ tools: [FORECAST_TOOL, CITY_TOOL], latency: (method, params) => (params?.name === "get_city_forecast" ? 900 : 40) });
    const { rule } = await check(server, { calls: [DENVER] });
    expect(rule("DL-04")).toMatchObject({ status: "WARN", notes: expect.stringContaining(`Over: tools/call ${DENVER_LABEL} 900 ms.`) });
  });

  it("probes sign-in with a listed read-only call when no tool needs no arguments", async () => {
    const server = fakeServer({ auth: { token: TOKEN, guard: "tools/call" }, tools: [CITY_TOOL] });
    const { rule } = await check(server, { token: TOKEN, calls: [DENVER] });
    expect(rule("AU-01").notes).toBe(`An unauthenticated tools/call ${DENVER_LABEL} was refused with HTTP 401.`);
  });

  it("never probes sign-in with a call that might change something", async () => {
    const server = fakeServer({ auth: { token: TOKEN, guard: "tools/call" }, tools: [BOOKING_TOOL] });
    const { rule } = await check(server, { token: TOKEN, calls: [BOOKING] });
    // The booking is made once, signed in; the unsigned probe calls a made-up tool instead.
    expect(server.calledTools().filter((name) => name === "book_table")).toHaveLength(1);
    expect(rule("AU-01").notes).toContain(MISSING);
  });

  it("checks the list before sending anything", async () => {
    const server = fakeServer();
    await expect(check(server, { calls: [{ tool: "" }] })).rejects.toThrow(TypeError);
    expect(server.sent).toHaveLength(0);
  });
});

describe("parseCalls", () => {
  it("fills in empty arguments and keeps the rest as given", () => {
    expect(parseCalls([{ tool: "get_forecast" }, { tool: "get_city_forecast", arguments: { city: "Denver" } }])).toEqual([
      { tool: "get_forecast", arguments: {} },
      { tool: "get_city_forecast", arguments: { city: "Denver" } },
    ]);
  });

  it.each([
    ["a file that isn't a list", { tool: "get_forecast" }, "calls.json must be a list of calls, like"],
    ["an empty list", [], "calls.json lists no calls"],
    ["too many calls", Array.from({ length: MAX_CALLS + 1 }, () => ({ tool: "t" })), `the check makes at most ${MAX_CALLS}`],
    ["an entry that isn't an object", ["get_forecast"], `Call 1 in calls.json isn't an object with a "tool"`],
    ["a call named with tools/call's word", [{ name: "get_forecast" }], `Call 1 in calls.json has no "tool"; name the tool with "tool", not "name".`],
    ["a call with no tool", [{ arguments: {} }], `Call 1 in calls.json has no "tool".`],
    ["an empty tool name", [{ tool: " " }], `has a "tool" that isn't a tool's name`],
    ["arguments that aren't an object", [{ tool: "t", arguments: ["Denver"] }], `Call 1 (t) in calls.json has "arguments" that aren't an object`],
    ["a key it doesn't know", [{ tool: "t" }, { tool: "u", args: {} }], `Call 2 (u) in calls.json has "args" besides "tool" and "arguments".`],
  ])("refuses %s, saying what's wrong", (_, value, message) => {
    expect(() => parseCalls(value, "calls.json")).toThrow(TypeError);
    expect(() => parseCalls(value, "calls.json")).toThrow(message);
  });

  it("keeps any well-formed list as it is, and refuses anything that isn't a list", () => {
    const json = fc.jsonValue();
    const args = fc.dictionary(fc.string(), json, { maxKeys: 4 });
    const call = fc.record({ tool: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0), arguments: args });
    fc.assert(
      fc.property(fc.array(call, { minLength: 1, maxLength: 20 }), (calls) => {
        expect(parseCalls(calls)).toEqual(calls);
      }),
    );
    fc.assert(
      fc.property(json.filter((v) => !Array.isArray(v)), (value) => {
        expect(() => parseCalls(value)).toThrow(TypeError);
      }),
    );
  });
});
