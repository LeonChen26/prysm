/** @type {import('next').NextConfig} */
const nextConfig = {
  // pi 相关包是 ESM + 原生 node 依赖，交给 Node 运行时直接解析，避免被 Next 打包器转换
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-telemetry",
    "typebox",
  ],
};

export default nextConfig;
