// what the agent may send to PATCH /deliveries/:orderPublicId/status (deliveries.md §2)
export enum DeliveryAction {
    PICKED = "picked",
    DELIVERED = "delivered",
    RELEASED = "released"            // give an assigned order back before pickup
}

// pg_advisory_xact_lock(class, agentId): one class id for "agent takes an order" on this service
export const AGENT_LOCK_CLASS = 7301;
