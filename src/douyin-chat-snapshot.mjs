export function findNewMessageOnSide(previousSnapshot, currentSnapshot, side) {
  const previousCounts = new Map();
  for (const message of previousSnapshot?.messages ?? []) {
    previousCounts.set(
      message.fingerprint,
      (previousCounts.get(message.fingerprint) ?? 0) + 1,
    );
  }

  const newMessages = [];
  for (const message of currentSnapshot?.messages ?? []) {
    const remaining = previousCounts.get(message.fingerprint) ?? 0;
    if (remaining > 0) {
      previousCounts.set(message.fingerprint, remaining - 1);
    } else {
      newMessages.push(message);
    }
  }

  return (
    newMessages
      .filter((message) => message.side === side)
      .sort((left, right) => left.ordinalFromEnd - right.ordinalFromEnd)[0] ?? null
  );
}

export function findExpectedNewOutgoingMessage(
  previousSnapshot,
  currentSnapshot,
  expectedFingerprint,
) {
  const previousCounts = new Map();
  for (const message of previousSnapshot?.messages ?? []) {
    previousCounts.set(
      message.fingerprint,
      (previousCounts.get(message.fingerprint) ?? 0) + 1,
    );
  }

  const newOutgoing = [];
  for (const message of currentSnapshot?.messages ?? []) {
    const remaining = previousCounts.get(message.fingerprint) ?? 0;
    if (remaining > 0) {
      previousCounts.set(message.fingerprint, remaining - 1);
    } else if (message.side === "right") {
      newOutgoing.push(message);
    }
  }

  return newOutgoing.length === 1 && newOutgoing[0].fingerprint === expectedFingerprint
    ? newOutgoing[0]
    : null;
}

export function findNewIncomingMessage(previousSnapshot, currentSnapshot) {
  return findNewMessageOnSide(previousSnapshot, currentSnapshot, "left");
}

export function findNewOutgoingMessage(previousSnapshot, currentSnapshot) {
  return findNewMessageOnSide(previousSnapshot, currentSnapshot, "right");
}
