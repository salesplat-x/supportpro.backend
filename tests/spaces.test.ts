const mockSend = jest.fn().mockResolvedValue({});

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

const DEFAULT_ENV = {
  doSpacesEndpoint: "https://nyc3.digitaloceanspaces.com",
  doSpacesRegion: "nyc3",
  doSpacesBucket: "salesplat",
  doSpacesKey: "test-key",
  doSpacesSecret: "test-secret",
};
const mockEnv = { ...DEFAULT_ENV };

// assertSpacesConfigured() re-reads env on every call, so mutating this shared
// object in place (rather than re-importing the module) is enough to simulate
// a misconfigured deploy.
jest.mock("../src/config/env.js", () => ({
  __esModule: true,
  default: mockEnv,
}));

// Must follow the jest.mock() calls above, which reference mockSend/mockEnv: jest
// hoists jest.mock() above imports but not above plain const declarations, so those
// consts have to come first in source order.
import { uploadToSpaces, deleteFromSpaces } from "../src/utils/integrations/spaces.js";

describe("spaces integration", () => {
  afterEach(() => {
    jest.clearAllMocks();
    Object.assign(mockEnv, DEFAULT_ENV);
  });

  it("uploads with the correct bucket/key/ACL and returns the DO Spaces virtual-hosted URL", async () => {
    const url = await uploadToSpaces(Buffer.from("data"), "avatars/user-1/abc.jpg", "image/jpeg");

    expect(url).toBe("https://salesplat.nyc3.digitaloceanspaces.com/avatars/user-1/abc.jpg");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [{ input }] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(input["Bucket"]).toBe("salesplat");
    expect(input["Key"]).toBe("avatars/user-1/abc.jpg");
    expect(input["ContentType"]).toBe("image/jpeg");
    expect(input["ACL"]).toBe("public-read");
  });

  it("deletes with the correct bucket/key", async () => {
    await deleteFromSpaces("cvs/user-1/old.pdf");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [{ input }] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(input["Bucket"]).toBe("salesplat");
    expect(input["Key"]).toBe("cvs/user-1/old.pdf");
  });

  it.each([
    "doSpacesEndpoint",
    "doSpacesRegion",
    "doSpacesBucket",
    "doSpacesKey",
    "doSpacesSecret",
  ])(
    "throws a clear config error instead of a broken URL when %s is missing",
    async (missingVar) => {
      Object.assign(mockEnv, { [missingVar]: undefined });

      await expect(
        uploadToSpaces(Buffer.from("data"), "avatars/user-1/abc.jpg", "image/jpeg")
      ).rejects.toThrow("DigitalOcean Spaces is not configured");
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});
