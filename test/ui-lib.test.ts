import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cspFix, cspFor, echoable, resultText, rpcLabel, schemaSkeleton, ToolNames, withCsp } from "../src/ui/lib.ts";

describe("a screen's Content Security Policy", () => {
  it("allows nothing from the network unless the resource declares it", () => {
    const policy = cspFor();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).not.toContain("https:");
  });

  it("adds the declared origins to the directives the MCP Apps standard maps them to", () => {
    const policy = cspFor({ connectDomains: ["https://api.example.com", "wss://live.example.com:8443"], resourceDomains: ["https://*.cdn.example"], frameDomains: ["https://player.example"] });
    expect(policy).toContain("connect-src https://api.example.com wss://live.example.com:8443");
    expect(policy).toMatch(/img-src data: blob: https:\/\/\*\.cdn\.example/);
    expect(policy).toMatch(/script-src 'unsafe-inline' https:\/\/\*\.cdn\.example/);
    expect(policy).toContain("frame-src https://player.example");
  });

  it("drops anything that isn't a plain origin, so a declaration can't rewrite the policy", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (junk) => {
        const policy = cspFor({ connectDomains: junk, resourceDomains: junk });
        // Nine directives, each one plain: no quotes but the keywords, no extra semicolons.
        expect(policy.split("; ")).toHaveLength(9);
        for (const token of policy.split(/[ ;]+/)) expect(token).toMatch(/^(?:[a-z-]+|'none'|'unsafe-inline'|data:|blob:|(?:https?|wss?):\/\/[a-z0-9*.:-]+)$/i);
      }),
    );
    expect(cspFor({ connectDomains: ["https://a.example; script-src *", "javascript:alert(1)", "https://ok.example/path", 7] })).toContain("connect-src 'none'");
  });

  it("goes first in <head>, with a watcher that reports what it blocked", () => {
    const html = withCsp('<!doctype html><html><head><title>x</title><script src="https://cdn.example/a.js"></script></head><body></body></html>');
    const meta = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(html.indexOf("<head>"));
    expect(meta).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain("securitypolicyviolation");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("finds a place for itself in a document without <head>, and keeps the doctype first", () => {
    expect(withCsp("<html><body>hi</body></html>")).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy"/);
    expect(withCsp("<!DOCTYPE html><p>hi</p>")).toMatch(/^<!DOCTYPE html><head><meta/);
    expect(withCsp("<p>hi</p>")).toMatch(/^<head><meta/);
    expect(withCsp('<html lang="en"><HEAD data-x="1"><p>hi</p>')).toMatch(/<HEAD data-x="1"><meta http-equiv/);
  });

  it("says where to declare what was blocked", () => {
    expect(cspFix("connect-src")).toBe("connectDomains");
    expect(cspFix("frame-src")).toBe("frameDomains");
    expect(cspFix("img-src")).toBe("resourceDomains");
    expect(cspFix("script-src-elem")).toBe("resourceDomains");
  });
});

describe("tool names for the model", () => {
  it("are always ones the Claude API accepts, distinct, and lead back to the server's own", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ maxLength: 90 }), { maxLength: 40 }), (mcpNames) => {
        const names = new ToolNames();
        const model = mcpNames.map((n) => names.add(n));
        expect(new Set(model).size).toBe(model.length);
        model.forEach((m, i) => {
          expect(m).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
          expect(names.mcp(m)).toBe(mcpNames[i]);
          expect(names.add(mcpNames[i]!)).toBe(m);
        });
      }),
    );
  });

  it("keep a name that's already fine", () => {
    const names = new ToolNames();
    expect(names.add("show_today")).toBe("show_today");
    expect(names.add("github.search")).toBe("github_search");
    expect(names.add("github/search")).toBe("github_search_2");
  });
});

describe("argument skeletons", () => {
  it("fill each required property with its default, example, first choice or an empty value", () => {
    expect(
      schemaSkeleton({
        type: "object",
        properties: {
          day: { type: "string", examples: ["2026-10-16"] },
          count: { type: "integer", default: 3 },
          view: { type: "string", enum: ["today", "week"] },
          done: { type: "boolean" },
          tags: { type: "array" },
          where: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
          note: { type: ["null", "string"] },
          optional: { type: "string" },
        },
        required: ["day", "count", "view", "done", "tags", "where", "note"],
      }),
    ).toEqual({ day: "2026-10-16", count: 3, view: "today", done: false, tags: [], where: { room: "" }, note: "" });
    expect(schemaSkeleton(undefined)).toEqual({});
    expect(schemaSkeleton({ type: "object" })).toEqual({});
  });
});

describe("what goes back to the model", () => {
  it("drops what the fallback model replaced, and nothing when there was no fallback", () => {
    const plain = [{ type: "thinking" }, { type: "text" }, { type: "tool_use" }];
    expect(echoable(plain)).toEqual(plain);
    const fell = [{ type: "thinking" }, { type: "tool_use" }, { type: "text" }, { type: "fallback" }, { type: "thinking" }, { type: "tool_use" }];
    expect(echoable(fell).map((b) => b.type)).toEqual(["text", "fallback", "thinking", "tool_use"]);
  });

  it("reads a tool's result as text, names what isn't text, and falls back to its structured content", () => {
    expect(resultText({ content: [{ type: "text", text: "Two events." }, { type: "image", mimeType: "image/png" }] })).toBe("Two events.\n[An image (image/png)]");
    expect(resultText({ content: [], structuredContent: { events: 2 } })).toBe('{"events":2}');
    expect(resultText({})).toBe("");
  });

  it("labels traffic by tool and resource", () => {
    expect(rpcLabel("tools/call", { name: "show_today" })).toBe("tools/call show_today");
    expect(rpcLabel("resources/read", { uri: "ui://today" })).toBe("resources/read ui://today");
    expect(rpcLabel("initialize", {})).toBe("initialize");
  });
});
