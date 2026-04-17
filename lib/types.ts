export interface ParsedQuery {
  targetUrl: string | null;
  searchObjective: string;
  maxPages: number;
}

export interface ContentFinding {
  pageUrl: string;
  pageTitle: string;
  sectionHeading: string;
  extractedText: string;
  screenshotBuffer: Buffer;
  relevanceScore: number;
}

export interface BrowseResult {
  query: ParsedQuery;
  findings: ContentFinding[];
  pagesVisited: string[];
  errors: string[];
  durationMs: number;
}

export type ProgressCallback = (message: string) => Promise<void>;
