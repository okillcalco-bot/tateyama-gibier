import { manualPublisher } from "./manual-publisher";
import type { SocialPublisher } from "./types";

/**
 * publisher の登録簿。
 * Phase 2 で Meta / LINE / GBP を足すときは、ここに1行加えるだけで済む。
 */
const PUBLISHERS: SocialPublisher[] = [manualPublisher];

export function getPublisher(channelKey: string): SocialPublisher {
  return PUBLISHERS.find((p) => p.key !== "manual" && p.canPublish(channelKey)) ?? manualPublisher;
}

export function listPublishers(): SocialPublisher[] {
  return PUBLISHERS;
}
