/** Runs `fn`, rejecting if it exceeds `ms` (when set). */
export async function withTimeout<T>(ms: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (!ms) return fn();

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
