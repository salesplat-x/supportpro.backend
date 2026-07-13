/**
 * Caps concurrent async operations within this process so bursts (e.g. many CV
 * uploads or batch CV scoring requests arriving at once) don't fire unlimited
 * parallel requests at a rate-limited external API. Excess work waits in an
 * in-memory FIFO queue instead of firing immediately.
 */
export interface Limiter {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

export const createLimiter = (maxConcurrent: number): Limiter => {
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      queue.push(() => {
        active++;
        resolve();
      });
    });
  };

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
};
