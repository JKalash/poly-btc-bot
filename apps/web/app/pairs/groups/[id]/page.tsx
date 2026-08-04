"use client";

import { use } from "react";
import {
  PairDetailState, PairGroupDetailView, PairSafetyBanner,
  type PairEventsResponse, type PairReconciliationsResponse,
} from "../../../../components/pair-detail";
import type { PairGroupDetail } from "../../../../lib/pair-detail";
import { useApi } from "../../../../lib/hooks";

export default function PairGroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const encodedId = encodeURIComponent(id);
  const group = useApi<PairGroupDetail>(`/api/pairs/groups/${encodedId}`);
  const events = useApi<PairEventsResponse>(`/api/pairs/groups/${encodedId}/events?limit=200`);
  const reconciliations = useApi<PairReconciliationsResponse>(`/api/pairs/groups/${encodedId}/reconciliations?limit=200`);

  let content;
  if (group.error === "pair_resource_not_found") {
    content = <PairDetailState kind="not-found" />;
  } else if (group.error) {
    content = <PairDetailState kind="error" message={group.error} />;
  } else if (!group.data) {
    content = <PairDetailState kind="loading" />;
  } else {
    content = (
      <PairGroupDetailView
        group={group.data}
        events={events.data?.items ?? []}
        reconciliations={reconciliations.data?.items ?? []}
        eventsLoading={!events.data && !events.error}
        reconciliationsLoading={!reconciliations.data && !reconciliations.error}
      />
    );
  }

  return <div className="space-y-3"><PairSafetyBanner />{content}</div>;
}
