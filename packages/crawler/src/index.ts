export {
  discoverSameOriginLinks,
  normalizeCrawlUrl,
  type DiscoveredLink,
  type LinkDiscoveryOptions,
} from "./links.js";

export {
  discoverSitemapUrls,
  parseRobotsSitemaps,
  parseSitemapXml,
  type ParsedSitemap,
  type SitemapDiscoveryOptions,
  type SitemapDiscoveryResult,
  type SitemapDiscoveryError,
  type SitemapFetcher,
} from "./sitemap.js";
