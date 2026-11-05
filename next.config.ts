import type { NextConfig } from "next";
import path from "node:path";
const dockerBuild = process.env.EXITWISE_BUILD_TARGET === "docker";

const nextConfig: NextConfig = {
  ...(dockerBuild ? { output: "standalone" as const, distDir: ".next-docker", typescript: { tsconfigPath: "tsconfig.docker.json" } } : {}),
  poweredByHeader: false,
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^cloudflare:workers$/, path.resolve("docker/runtime.mjs")));
    return config;
  },
};

export default nextConfig;
