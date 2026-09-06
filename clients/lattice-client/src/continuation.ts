export interface ContinuationProfile {
  mode: "bounded_continuation";
  version: 1;
  product: "treehouse";
  kind: "space" | "thread";
  role: "admin" | "moderator";
  nominee: string;
  witnesses: string[];
  threshold: number;
  maxLeaseEpochs: number;
}

export function normalizeContinuationProfile(_value: unknown): ContinuationProfile | null {
  return null;
}
