import type { Response } from "superagent";
import type { ApiResponse } from "../../src/utils/response.js";

/**
 * Extracts the typed `data` payload from a supertest response. supertest/superagent
 * type `res.body` as `any`, so unguarded `res.body.data.x.y` chains are invisible to
 * no-unsafe-* lint rules — this centralizes the one necessary cast to a single,
 * explicit boundary instead of leaving `any` to propagate through every assertion.
 */
export function apiData<T = unknown>(res: Response): T {
  return (res.body as ApiResponse<T>).data as T;
}
