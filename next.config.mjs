/** @type {import('next').NextConfig} */
const nextConfig = {
  // 生成 standalone 产物（含精简依赖），便于 ECS/容器直接部署
  output: "standalone",
  reactStrictMode: true,
  // 去掉 X-Powered-By 响应头，减少暴露信息
  poweredByHeader: false,
  // pi 相关包是 ESM + 原生 node 依赖，交给 Node 运行时直接解析，避免被 Next 打包器转换
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-telemetry",
    "typebox",
  ],
  // 客户端依赖按需打包，减小产物体积（服务端包走 serverExternalPackages，不在此列）
  experimental: {
    optimizePackageImports: ["react-markdown", "remark-gfm"],
  },
};

export default nextConfig;
