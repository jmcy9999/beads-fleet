import { execSync } from "child_process";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    GIT_SHA: execSync("git rev-parse HEAD").toString().trim(),
    BUILD_TIME: new Date().toISOString(),
  },
  experimental: {
    serverComponentsExternalPackages: [
      "better-sqlite3",
      "@opentelemetry/sdk-node",
      "@opentelemetry/sdk-trace-node",
      "@langfuse/otel",
      "@langfuse/tracing",
      "@grpc/grpc-js",
    ],
    instrumentationHook: true,
  },
};

export default nextConfig;
