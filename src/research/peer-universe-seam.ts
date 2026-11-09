import type { ModelProvider } from "../model/types";
import type { PeerUniverseSeam } from "../sources/collector-equity-enrichment";
import {
  makePeerUniverseCacheReader,
  makePeerUniverseCacheWriter,
  makePeerUniverseEvaluationRecorder,
  makePeerUniverseRefreshClaimer,
  makePeerUniverseRefreshReleaser,
} from "./peer-universe-cache";
import { createPeerUniverseProposer } from "./peer-universe-proposal";

export interface PeerUniverseModelOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly cachePath: string;
  readonly ttlDays?: number;
}

export function peerUniverseSeam(peerUniverse: PeerUniverseModelOptions): PeerUniverseSeam {
  return (ctx, now) => ({
    cacheRead: makePeerUniverseCacheReader(peerUniverse.cachePath, peerUniverse.ttlDays, now),
    cacheWrite: makePeerUniverseCacheWriter(
      peerUniverse.cachePath,
      peerUniverse.ttlDays,
      peerUniverse.provider.name,
      now,
    ),
    claimRefresh: makePeerUniverseRefreshClaimer(peerUniverse.cachePath, peerUniverse.ttlDays, now),
    recordEvaluation: makePeerUniverseEvaluationRecorder(peerUniverse.cachePath, now),
    releaseRefresh: makePeerUniverseRefreshReleaser(peerUniverse.cachePath, now),
    propose: createPeerUniverseProposer({
      provider: peerUniverse.provider,
      model: peerUniverse.model,
      request: ctx.request,
      ...(ctx.secUserAgent !== undefined ? { secUserAgent: ctx.secUserAgent } : {}),
      ...(ctx.instrumentIdentity?.displayName !== undefined
        ? { targetName: ctx.instrumentIdentity.displayName }
        : {}),
    }),
  });
}
