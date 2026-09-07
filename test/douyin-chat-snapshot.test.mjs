import test from "node:test";
import assert from "node:assert/strict";
import {
  findExpectedNewOutgoingMessage,
  findNewIncomingMessage,
  findNewOutgoingMessage,
} from "../src/douyin-chat-snapshot.mjs";

test("finds a new left-side message", () => {
  const previous = {
    messages: [{ fingerprint: "old", side: "left", ordinalFromEnd: 1 }],
  };
  const current = {
    messages: [
      { fingerprint: "old", side: "left", ordinalFromEnd: 2 },
      { fingerprint: "new", side: "left", ordinalFromEnd: 1, kind: "text" },
    ],
  };
  assert.equal(findNewIncomingMessage(previous, current)?.fingerprint, "new");
});

test("handles a repeated message by occurrence count", () => {
  const repeated = { fingerprint: "same", side: "left", kind: "text" };
  const incoming = findNewIncomingMessage(
    { messages: [{ ...repeated, ordinalFromEnd: 1 }] },
    {
      messages: [
        { ...repeated, ordinalFromEnd: 2 },
        { ...repeated, ordinalFromEnd: 1 },
      ],
    },
  );
  assert.equal(incoming?.ordinalFromEnd, 1);
});

test("ignores new outgoing and system entries", () => {
  assert.equal(
    findNewIncomingMessage(
      { messages: [] },
      {
        messages: [
          { fingerprint: "right", side: "right", ordinalFromEnd: 1 },
          { fingerprint: "center", side: "center", ordinalFromEnd: 2 },
        ],
      },
    ),
    null,
  );
});

test("finds a new right-side outgoing message", () => {
  assert.equal(
    findNewOutgoingMessage(
      { messages: [] },
      { messages: [{ fingerprint: "sent", side: "right", ordinalFromEnd: 1 }] },
    )?.fingerprint,
    "sent",
  );
});

test("accepts only the exact expected outgoing as send verification", () => {
  const previous = {
    messages: [{ fingerprint: "old", side: "left", ordinalFromEnd: 1 }],
  };
  assert.equal(
    findExpectedNewOutgoingMessage(previous, {
      messages: [
        { fingerprint: "old", side: "left", ordinalFromEnd: 2 },
        { fingerprint: "expected", side: "right", ordinalFromEnd: 1 },
      ],
    }, "expected")?.fingerprint,
    "expected",
  );
  assert.equal(
    findExpectedNewOutgoingMessage(previous, {
      messages: [
        { fingerprint: "old", side: "left", ordinalFromEnd: 2 },
        { fingerprint: "different", side: "right", ordinalFromEnd: 1 },
      ],
    }, "expected"),
    null,
  );
  assert.equal(
    findExpectedNewOutgoingMessage(previous, {
      messages: [
        { fingerprint: "expected", side: "right", ordinalFromEnd: 2 },
        { fingerprint: "concurrent", side: "right", ordinalFromEnd: 1 },
      ],
    }, "expected"),
    null,
  );
  assert.equal(
    findExpectedNewOutgoingMessage(previous, {
      messages: [
        { fingerprint: "old", side: "left", ordinalFromEnd: 4, kind: "text" },
        { fingerprint: "expected", side: "right", ordinalFromEnd: 3, kind: "text" },
        { fingerprint: "system", side: "right", ordinalFromEnd: 2, kind: "system" },
        { fingerprint: "unknown", side: "right", ordinalFromEnd: 1, kind: "unknown" },
      ],
    }, "expected")?.fingerprint,
    "expected",
  );
  assert.equal(
    findExpectedNewOutgoingMessage(previous, {
      messages: [
        { fingerprint: "expected", side: "right", ordinalFromEnd: 2, kind: "text" },
        { fingerprint: "extra", side: "right", ordinalFromEnd: 1, kind: "media" },
      ],
    }, "expected"),
    null,
  );
});

test("requires the exact quoted shared-work identity when one is expected", () => {
  const target = "a".repeat(64);
  const current = {
    messages: [{
      fingerprint: "expected",
      quoteTargetFingerprint: target,
      side: "right",
      ordinalFromEnd: 1,
    }],
  };
  assert.equal(
    findExpectedNewOutgoingMessage({ messages: [] }, current, "expected", target)
      ?.quoteTargetFingerprint,
    target,
  );
  assert.equal(
    findExpectedNewOutgoingMessage(
      { messages: [] },
      current,
      "expected",
      "b".repeat(64),
    ),
    null,
  );
});
