import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "../src/check/sse.ts";
import { differences } from "../src/check/data-layer.ts";

/** Text with no line breaks, since those end an SSE line. */
const lineText = fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, ""));

const eventArb = fc.record(
  {
    event: lineText.filter((s) => s.length > 0),
    data: fc.array(lineText, { minLength: 1, maxLength: 3 }).map((lines) => lines.join("\n")),
    id: lineText.map((s) => s.replace(/\0/g, "")),
    comment: lineText,
  },
  { requiredKeys: ["data"] },
);

function parseAll(chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

describe("SseParser", () => {
  it("gets the same events however the stream is split and whatever line endings it uses", () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 6 }),
        fc.array(fc.constantFrom("\n", "\r\n", "\r"), { minLength: 1, maxLength: 5 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        (events, endings, cuts) => {
          let n = 0;
          let previous = "";
          // A bare \r then a \n would read as one \r\n, so after a \r, a \n ending is written as \r\n.
          const end = () => {
            const next = endings[n++ % endings.length]!;
            previous = previous === "\r" && next === "\n" ? "\r\n" : next;
            return previous;
          };
          let text = "";
          let lastId: string | undefined;
          const expected: SseEvent[] = [];
          for (const e of events) {
            if (e.comment !== undefined) text += `:${e.comment}${end()}`;
            if (e.event !== undefined) text += `event: ${e.event}${end()}`;
            if (e.id !== undefined) {
              text += `id: ${e.id}${end()}`;
              lastId = e.id;
            }
            for (const line of e.data.split("\n")) text += `data: ${line}${end()}`;
            text += end();
            expected.push({ event: e.event ?? "message", data: e.data, ...(lastId !== undefined ? { id: lastId } : {}) });
          }
          const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
          const chunks = [0, ...points].map((start, i, all) => text.slice(start, all[i + 1] ?? text.length));
          expect(parseAll(chunks)).toEqual(expected);
        },
      ),
    );
  });

  it("keeps a \\r\\n split across chunks as one line ending", () => {
    expect(parseAll(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"])).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });

  it("ignores comments, retry and unknown fields, and an event with no data", () => {
    expect(parseAll([": keepalive\n\nretry: 100\nevent: ping\n\nfoo: bar\ndata:x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("delivers an event the stream ends in the middle of", () => {
    expect(parseAll(['data: {"id":1}'])).toEqual([{ event: "message", data: '{"id":1}' }]);
    expect(parseAll(["data: a\n"])).toEqual([{ event: "message", data: "a" }]);
  });
});

describe("differences", () => {
  it("finds none between a value and itself, and some exactly when two values differ", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        expect(differences(a, structuredClone(a))).toEqual([]);
        expect(differences(a, b).length === 0).toBe(isDeepStrictEqual(a, b));
      }),
    );
  });

  it("names the paths that changed", () => {
    expect(differences({ content: [{ text: "a" }], n: 1, same: true }, { content: [{ text: "b" }], n: 2, same: true })).toEqual([
      "content[0].text",
      "n",
    ]);
    expect(differences([1, 2], [1, 2, 3])).toEqual(["[2]"]);
    expect(differences("a", "b")).toEqual(["the whole result"]);
  });
});
