import { describe, expect, it } from "vitest";
import { FRONTEND_BUILD_IDENTITY } from "../../generated/buildIdentity";
import { assertMatchingBuildIdentity } from "../buildIdentity";

const matchingBackendIdentity = {
  productId: FRONTEND_BUILD_IDENTITY.productId,
  productVersion: FRONTEND_BUILD_IDENTITY.productVersion,
  frontendContractVersion: FRONTEND_BUILD_IDENTITY.frontendContractVersion,
  frontendSourceHash: FRONTEND_BUILD_IDENTITY.sourceHash,
};

describe("build identity handshake", () => {
  it("accepts the backend compiled with the same frontend", () => {
    expect(() =>
      assertMatchingBuildIdentity(matchingBackendIdentity),
    ).not.toThrow();
  });

  it("rejects a backend compiled with another frontend", () => {
    expect(() =>
      assertMatchingBuildIdentity({
        ...matchingBackendIdentity,
        frontendSourceHash: "another-project",
      }),
    ).toThrow(/前端源码指纹/);
  });

  it("rejects another product even if its version matches", () => {
    expect(() =>
      assertMatchingBuildIdentity({
        ...matchingBackendIdentity,
        productId: "com.example.uufishing",
      }),
    ).toThrow(/产品标识/);
  });
});
