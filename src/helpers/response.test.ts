import { makeResponse } from "./response";

describe("makeResponse", () => {
  it("builds a success response shape", () => {
    expect(makeResponse(true, "ok", { id: 1 }, 200)).toEqual({
      status: true,
      message: "ok",
      data: { id: 1 },
      statusCode: 200,
    });
  });

  it("builds an error response shape without data/statusCode", () => {
    expect(makeResponse(false, "failed")).toEqual({
      status: false,
      message: "failed",
      data: undefined,
      statusCode: undefined,
    });
  });
});
