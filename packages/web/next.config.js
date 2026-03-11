/** @type {import('next').NextConfig} */
import { normalizeBasePath } from "./src/lib/base-path.js";

export { normalizeBasePath };

const normalizedBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH ?? "");

const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  basePath: normalizedBasePath || undefined,
};

export default nextConfig;
