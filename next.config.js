/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: [
      "@azure/ai-form-recognizer",
      "@google/generative-ai",
      "sharp"
    ]
  }
};

module.exports = nextConfig;
