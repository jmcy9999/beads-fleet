/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
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
