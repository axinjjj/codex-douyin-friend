export async function runDouyinCleanupSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0
      || steps.some((step) => typeof step !== "function")) {
    throw new Error("A non-empty list of Douyin cleanup steps is required.");
  }
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple Douyin runtime cleanup steps failed.");
  }
}
