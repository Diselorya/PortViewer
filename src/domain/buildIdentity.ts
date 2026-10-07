import { invoke } from "../services/backend";
import { FRONTEND_BUILD_IDENTITY } from "../generated/buildIdentity";

export interface BackendBuildIdentity {
  productId: string;
  productVersion: string;
  frontendContractVersion: number;
  frontendSourceHash: string;
}

export function assertMatchingBuildIdentity(
  backend: BackendBuildIdentity,
): void {
  const expected = FRONTEND_BUILD_IDENTITY;
  const mismatches = [
    backend.productId === expected.productId
      ? null
      : `产品标识 ${backend.productId} ≠ ${expected.productId}`,
    backend.productVersion === expected.productVersion
      ? null
      : `版本 ${backend.productVersion} ≠ ${expected.productVersion}`,
    backend.frontendContractVersion === expected.frontendContractVersion
      ? null
      : `接口契约 ${backend.frontendContractVersion} ≠ ${expected.frontendContractVersion}`,
    backend.frontendSourceHash === expected.sourceHash
      ? null
      : `前端源码指纹 ${backend.frontendSourceHash} ≠ ${expected.sourceHash}`,
  ].filter((message): message is string => message !== null);

  if (mismatches.length > 0) {
    throw new Error(mismatches.join("；"));
  }
}

export async function verifyBuildIdentity(): Promise<void> {
  const backend = await invoke<BackendBuildIdentity>("get_build_identity");
  assertMatchingBuildIdentity(backend);
}
