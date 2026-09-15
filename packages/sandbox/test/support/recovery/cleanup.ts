export async function withCleanup(
  action: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await action()
  } catch (primary) {
    try {
      await cleanup()
    } catch (secondary) {
      throw new AggregateError([primary, secondary], "Primary operation and cleanup failed")
    }
    throw primary
  }
  await cleanup()
}
