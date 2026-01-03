/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "@azure/ai-form-recognizer",
      "@azure/storage-blob",
      "@google/generative-ai",
      "canvas",
      "pdfjs-dist"
    ]
  }
};

module.exports = nextConfig;
