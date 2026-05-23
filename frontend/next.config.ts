import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone",
  reactCompiler: true,
  async rewrites() {
    return [
      {
        source: "/sitemap.xml",
        destination: "/api/sitemap/sitemap.xml",
      },
      {
        source: "/sitemap_:slug.xml",
        destination: "/api/sitemap/sitemap_:slug.xml",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default withBundleAnalyzer(nextConfig);
