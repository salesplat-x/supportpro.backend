export type SeedCliOptions = {
  n: number;
  reset: boolean;
};

export function isProductionEnv(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  appEnv?: string
): boolean {
  return nodeEnv === "production" || appEnv === "production";
}

export function assertNotProduction(appEnv?: string): void {
  if (isProductionEnv(process.env.NODE_ENV, appEnv)) {
    throw new Error(
      "Refusing to seed the database because NODE_ENV/app environment is production."
    );
  }
}

export function parseSeedArgs(argv: string[]): SeedCliOptions {
  const args = argv.slice(2);
  const reset = args.includes("--reset");
  const nToken = args.find((token) => /^\d+$/.test(token));
  if (!nToken) {
    throw new Error("Usage: npm run seed -- <N> [--reset]\nN is a positive integer scale factor.");
  }
  const n = Number(nToken);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("Scale factor N must be a positive integer.");
  }
  return { n, reset };
}
